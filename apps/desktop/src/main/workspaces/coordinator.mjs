import { randomUUID } from 'node:crypto'
import { createWorkspace, getWorkspace, listCatalog, readCatalog, writeSelection, renameWorkspace, LEGACY_WORKSPACE_ID } from './catalog.mjs'
import { WORKSPACE_COPY, refusal } from './copy.mjs'
import { missingAuthority, DESKTOP_WORKSPACE_AUTHORITIES } from './ports.mjs'
import { findOpenReceipt, findReceiptByRequestId, isAfterDrainPhase, isTerminalPhase, touchReceipt, writeReceipt, publicReceipt, switchFingerprint } from './receipts.mjs'
import { CONTRACT_VERSION, inspectWorkspacePath, UUID, validWorkspaceId } from './paths.mjs'

/** One coordinator per install. A failed/uncertain close keeps its exact transition blocking until explicit recovery. */
export function createWorkspaceCoordinator({ dataRoot, installId, ports }) {
    if (!dataRoot || !UUID.test(installId) || !ports) throw new Error('Workspace coordinator requires owned install context')
    let gate = Promise.resolve(), switching = false
    function serialize(work) { const run = gate.then(work, work); gate = run.then(() => {}, () => {}); return run }
    async function list() {
        const { catalog, selection } = await listCatalog(dataRoot, installId)
        const open = await findOpenReceipt(dataRoot, installId)
        return { catalog, selection, openReceipt: open ? publicReceipt(open) : null }
    }
    const create = input => switching ? Promise.resolve(refusal('busy', WORKSPACE_COPY.busy)) : serialize(() => createWorkspace(dataRoot, installId, input))
    const rename = input => switching ? Promise.resolve(refusal('busy', WORKSPACE_COPY.busy)) : serialize(() => renameWorkspace(dataRoot, installId, input))
    async function reconcile() {
        const snapshot = await list()
        return { ...snapshot, selectedWorkspace: snapshot.catalog.workspaces.find(w => w.workspaceId === snapshot.selection.workspaceId) ?? null,
            requiresManualRecovery: Boolean(snapshot.openReceipt), authorities: DESKTOP_WORKSPACE_AUTHORITIES }
    }
    function transition(work) {
        if (switching) return Promise.resolve(refusal('busy', WORKSPACE_COPY.busy))
        switching = true
        return serialize(work).finally(() => { switching = false })
    }
    const switchTo = input => transition(() => switchWorkspace(input))
    const recoverSwitch = input => transition(async () => {
        if (!UUID.test(input?.requestId)) return refusal('unsupported', WORKSPACE_COPY.runtimeStartFailed)
        const receipt = await findReceiptByRequestId(dataRoot, input.requestId, installId)
        const open = await findOpenReceipt(dataRoot, installId)
        if (!receipt || !open || receipt.receiptId !== open.receiptId || isTerminalPhase(receipt.phase)
            || (input.workspaceId !== undefined && input.workspaceId !== receipt.toWorkspaceId)) return refusal('duplicate_request', 'That workspace recovery no longer matches the pending switch.')
        return perform(receipt)
    })
    async function switchWorkspace(input) {
        if (ports.isQuitInProgress?.()) return refusal('quit_in_progress', WORKSPACE_COPY.quitInProgress)
        if (!UUID.test(input?.requestId) || !validWorkspaceId(input?.workspaceId)) return refusal('unsupported', 'That workspace switch could not be started.')
        const existing = await findReceiptByRequestId(dataRoot, input.requestId, installId)
        if (existing) {
            if (existing.toWorkspaceId !== input.workspaceId || existing.fingerprint !== switchFingerprint(existing)) return refusal('duplicate_request', 'That request belongs to another workspace switch.')
            if (existing.phase === 'published') return { ok: true, receipt: publicReceipt(existing), workspace: (await getWorkspace(dataRoot, installId, existing.toWorkspaceId)).workspace }
            return refusal('busy', existing.reason || WORKSPACE_COPY.busy)
        }
        if (await findOpenReceipt(dataRoot, installId)) return refusal('busy', WORKSPACE_COPY.busy)
        const { catalog, selection } = await readCatalog(dataRoot, installId)
        const target = catalog.workspaces.find(w => w.workspaceId === input.workspaceId)
        if (!target) return refusal('not_found', WORKSPACE_COPY.notFound)
        const stamp = new Date().toISOString()
        const receipt = { version: CONTRACT_VERSION, receiptId: randomUUID(), requestId: input.requestId, fromWorkspaceId: selection.workspaceId,
            toWorkspaceId: input.workspaceId, phase: 'accepted', installId, createdAt: stamp, updatedAt: stamp,
            reason: null, admissionsFrozen: false, oldRuntimeClosed: false }
        if (selection.workspaceId === input.workspaceId) {
            const completed = touchReceipt(receipt, 'published')
            await writeReceipt(dataRoot, completed)
            return { ok: true, receipt: publicReceipt(completed), workspace: target }
        }
        const inspection = await inspectWorkspacePath(dataRoot, installId, input.workspaceId)
        if (inspection.status !== 'ready') return pathRefusal(inspection.status)
        await writeReceipt(dataRoot, receipt)
        return perform(receipt)
    }
    async function perform(initial) {
        let receipt = initial, closingAttempted = isAfterDrainPhase(initial.phase), freezeAttempted = false
        if (ports.isQuitInProgress?.()) return refusal('quit_in_progress', WORKSPACE_COPY.quitInProgress)
        const inspection = await inspectWorkspacePath(dataRoot, installId, receipt.toWorkspaceId)
        if (inspection.status !== 'ready') return pathRefusal(inspection.status)
        const context = { requestId: receipt.requestId, fromWorkspaceId: receipt.fromWorkspaceId, toWorkspaceId: receipt.toWorkspaceId }
        try {
            if (typeof ports.freezeAdmissions !== 'function') throw missingAuthority('W1-A2')
            freezeAttempted = true
            if (await ports.freezeAdmissions(context) !== true) throw Object.assign(new Error(), { publicCode: 'admissions_frozen', publicMessage: WORKSPACE_COPY.admissionsFrozen })
            receipt = touchReceipt(receipt, closingAttempted ? 'failed_after_drain' : 'admissions_frozen', { admissionsFrozen: true })
            await writeReceipt(dataRoot, receipt)
            if (typeof ports.flushDrafts !== 'function') throw missingAuthority('W1-A2')
            if ((await ports.flushDrafts(context))?.saved !== true) throw Object.assign(new Error(), { publicCode: 'draft_flush_failed', publicMessage: WORKSPACE_COPY.draftFlushFailed })
            if (!closingAttempted) { receipt = touchReceipt(receipt, 'drafts_flushed'); await writeReceipt(dataRoot, receipt) }
            if (typeof ports.stopAndDrain !== 'function') throw missingAuthority('W1-A1')
            // Reserve uncertainty before the await: a partial stop or crash is never a safe rollback.
            receipt = touchReceipt(receipt, 'old_runtime_closing')
            closingAttempted = true
            await writeReceipt(dataRoot, receipt)
            await ports.stopAndDrain(context)
            receipt = touchReceipt(receipt, 'old_runtime_closed', { oldRuntimeClosed: true }); await writeReceipt(dataRoot, receipt)
            if (typeof ports.bindAndStart !== 'function') throw missingAuthority('W1-A1')
            receipt = touchReceipt(receipt, 'target_starting'); await writeReceipt(dataRoot, receipt)
            const started = await ports.bindAndStart(receipt.toWorkspaceId, context)
            if (typeof ports.verifyRuntimeIdentity !== 'function') throw missingAuthority('W1-A3')
            if (started?.workspaceId !== receipt.toWorkspaceId || await ports.verifyRuntimeIdentity(receipt.toWorkspaceId, context) !== true) {
                throw Object.assign(new Error(), { publicCode: 'identity_mismatch', publicMessage: WORKSPACE_COPY.identityMismatch })
            }
            receipt = touchReceipt(receipt, 'identity_verified'); await writeReceipt(dataRoot, receipt)
            await writeSelection(dataRoot, { workspaceId: receipt.toWorkspaceId, publishedByReceiptId: receipt.receiptId, selectedAt: new Date().toISOString() })
            // Publish the verified selection durably before its new work can be admitted.
            receipt = touchReceipt(receipt, 'published', { reason: null }); await writeReceipt(dataRoot, receipt)
            if (typeof ports.unfreezeAdmissions !== 'function') throw missingAuthority('W1-A2')
            await ports.unfreezeAdmissions(context)
            return { ok: true, receipt: publicReceipt(receipt), workspace: (await getWorkspace(dataRoot, installId, receipt.toWorkspaceId)).workspace }
        } catch (error) {
            if (closingAttempted) {
                try { await ports.freezeAdmissions?.(context) } catch { /* Unconfirmed admission is preserved in the blocking transition. */ }
            }
            const reason = error.code === 'authority_missing' ? WORKSPACE_COPY.authorityMissing(error.authority) : error.publicMessage || WORKSPACE_COPY.runtimeStartFailed
            receipt = touchReceipt(receipt, closingAttempted ? 'failed_after_drain' : 'failed_before_drain', { reason })
            // Freeze may have committed before its acknowledgement was lost. Always confirm rollback,
            // even when the initial response never set admissionsFrozen. Once close was reserved,
            // this cleanup must never reopen the old runtime.
            if (!closingAttempted && freezeAttempted) {
                try {
                    if (typeof ports.unfreezeAdmissions !== 'function') throw missingAuthority('W1-A2')
                    await ports.unfreezeAdmissions(context)
                } catch { receipt = touchReceipt(receipt, 'admissions_frozen', { reason: WORKSPACE_COPY.admissionsFrozen }) }
            }
            await writeReceipt(dataRoot, receipt)
            return refusal(error.code === 'authority_missing' ? 'authority_missing' : error.publicCode || 'runtime_start_failed', reason, error.authority)
        }
    }
    async function coldLaunchTarget() {
        const snapshot = await reconcile()
        if (snapshot.openReceipt) return { ok: false, code: 'busy', message: WORKSPACE_COPY.busy, workspaceId: snapshot.openReceipt.toWorkspaceId, receipt: snapshot.openReceipt }
        const workspaceId = snapshot.selection.workspaceId, workspace = snapshot.catalog.workspaces.find(w => w.workspaceId === workspaceId)
        if (!workspace) return { ok: false, code: 'not_found', message: WORKSPACE_COPY.notFound, workspaceId: LEGACY_WORKSPACE_ID }
        if (workspace.pathStatus !== 'ready') return { ...pathRefusal(workspace.pathStatus), workspaceId }
        return { ok: true, workspaceId, workspace }
    }
    return { list, create, rename, switchTo, recoverSwitch, reconcile, coldLaunchTarget }
}
function pathRefusal(status) {
    return refusal(status === 'foreign' ? 'path_foreign' : status === 'missing' ? 'path_missing' : 'path_corrupt',
        status === 'foreign' ? WORKSPACE_COPY.pathForeign : status === 'missing' ? WORKSPACE_COPY.pathMissing : WORKSPACE_COPY.pathCorrupt)
}
