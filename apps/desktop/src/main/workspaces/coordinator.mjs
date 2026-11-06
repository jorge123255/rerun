import { randomUUID } from 'node:crypto'
import { createWorkspace, getWorkspace, listCatalog, readCatalog, writeSelection, LEGACY_WORKSPACE_ID } from './catalog.mjs'
import { WORKSPACE_COPY, refusal } from './copy.mjs'
import { missingAuthority, DESKTOP_WORKSPACE_AUTHORITIES } from './ports.mjs'
import {
    findOpenReceipt,
    findReceiptByRequestId,
    isAfterDrainPhase,
    isTerminalPhase,
    touchReceipt,
    writeReceipt,
} from './receipts.mjs'
import { CONTRACT_VERSION, inspectWorkspacePath } from './paths.mjs'

/**
 * Transition coordinator. Effects only run through injected ports. Missing
 * authorities fail closed — never assumed success.
 */
export function createWorkspaceCoordinator({ dataRoot, installId, ports }) {
    if (!dataRoot || !installId || !ports) throw new Error('Workspace coordinator requires dataRoot, installId and ports')
    let gate = Promise.resolve()

    function serialize(work) {
        const run = gate.then(work, work)
        gate = run.then(() => {}, () => {})
        return run
    }

    async function list() {
        const { catalog, selection } = await listCatalog(dataRoot, installId)
        const openReceipt = await findOpenReceipt(dataRoot)
        return { catalog, selection, openReceipt }
    }

    async function create(input) {
        return serialize(async () => createWorkspace(dataRoot, installId, input))
    }

    async function rename(input) {
        const { renameWorkspace } = await import('./catalog.mjs')
        return serialize(async () => renameWorkspace(dataRoot, installId, input))
    }

    /**
     * Non-effectful startup/read reconciliation.
     * - Does not start engines, create workspaces, erase data, or adopt foreign directories.
     * - Returns the open receipt so root/UI can offer Retry or stay put.
     */
    async function reconcile() {
        const snapshot = await list()
        const selected = snapshot.catalog.workspaces.find(w => Number(w.workspaceId) === Number(snapshot.selection.workspaceId))
        return {
            ...snapshot,
            selectedWorkspace: selected ?? null,
            requiresManualRecovery: Boolean(snapshot.openReceipt && isAfterDrainPhase(snapshot.openReceipt.phase) && !isTerminalPhase(snapshot.openReceipt.phase)),
            authorities: DESKTOP_WORKSPACE_AUTHORITIES,
        }
    }

    async function switchTo(input) {
        return serialize(() => switchWorkspace(input))
    }

    async function switchWorkspace(input) {
        if (ports.isQuitInProgress?.() === true) {
            return refusal('quit_in_progress', WORKSPACE_COPY.quitInProgress)
        }
        if (typeof input?.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.requestId)) {
            return refusal('unsupported', 'That workspace switch could not be started.')
        }
        const toWorkspaceId = Number(input.workspaceId)
        if (!Number.isInteger(toWorkspaceId) || toWorkspaceId < 1) {
            return refusal('not_found', WORKSPACE_COPY.notFound)
        }

        const existing = await findReceiptByRequestId(dataRoot, input.requestId)
        if (existing) {
            if (existing.phase === 'published') {
                const { workspace } = await getWorkspace(dataRoot, installId, existing.toWorkspaceId)
                return { ok: true, receipt: existing, workspace }
            }
            if (!isTerminalPhase(existing.phase)) return refusal('busy', WORKSPACE_COPY.busy)
            // Terminal non-success with same requestId: return the prior refusal shape.
            return refusal(existing.phase === 'cancelled' ? 'cancelled' : 'busy', existing.reason || WORKSPACE_COPY.busy)
        }

        const open = await findOpenReceipt(dataRoot)
        if (open && !isTerminalPhase(open.phase)) {
            return refusal('busy', WORKSPACE_COPY.busy)
        }

        const { catalog, selection } = await readCatalog(dataRoot, installId)
        const target = catalog.workspaces.find(w => Number(w.workspaceId) === toWorkspaceId)
        if (!target) return refusal('not_found', WORKSPACE_COPY.notFound)
        if (Number(selection.workspaceId) === toWorkspaceId) {
            // Exact no-op success without a runtime bounce.
            const stamp = new Date().toISOString()
            const receipt = {
                version: CONTRACT_VERSION,
                receiptId: randomUUID(),
                requestId: input.requestId,
                fromWorkspaceId: Number(selection.workspaceId),
                toWorkspaceId,
                phase: 'published',
                installId,
                createdAt: stamp,
                updatedAt: stamp,
                reason: null,
                admissionsFrozen: false,
                oldRuntimeClosed: false,
            }
            await writeReceipt(dataRoot, receipt)
            return { ok: true, receipt, workspace: target }
        }

        const inspection = await inspectWorkspacePath(dataRoot, installId, toWorkspaceId)
        if (inspection.status === 'missing') return refusal('path_missing', WORKSPACE_COPY.pathMissing)
        if (inspection.status === 'corrupt') return refusal('path_corrupt', WORKSPACE_COPY.pathCorrupt)
        if (inspection.status === 'foreign') return refusal('path_foreign', WORKSPACE_COPY.pathForeign)

        const stamp = new Date().toISOString()
        let receipt = {
            version: CONTRACT_VERSION,
            receiptId: randomUUID(),
            requestId: input.requestId,
            fromWorkspaceId: Number(selection.workspaceId),
            toWorkspaceId,
            phase: 'accepted',
            installId,
            createdAt: stamp,
            updatedAt: stamp,
            reason: null,
            admissionsFrozen: false,
            oldRuntimeClosed: false,
        }
        await writeReceipt(dataRoot, receipt)

        try {
            if (typeof ports.freezeAdmissions !== 'function') throw missingAuthority('W1-A2')
            const frozen = await ports.freezeAdmissions()
            if (frozen !== true) {
                receipt = touchReceipt(receipt, 'failed_before_drain', { reason: WORKSPACE_COPY.admissionsFrozen })
                await writeReceipt(dataRoot, receipt)
                return refusal('admissions_frozen', WORKSPACE_COPY.admissionsFrozen)
            }
            receipt = touchReceipt(receipt, 'admissions_frozen', { admissionsFrozen: true })
            await writeReceipt(dataRoot, receipt)

            if (typeof ports.flushDrafts !== 'function') throw missingAuthority('W1-A2')
            const flushed = await ports.flushDrafts()
            if (!flushed || flushed.saved !== true) {
                await safeUnfreeze(ports)
                receipt = touchReceipt(receipt, 'failed_before_drain', { reason: WORKSPACE_COPY.draftFlushFailed })
                await writeReceipt(dataRoot, receipt)
                return refusal('draft_flush_failed', WORKSPACE_COPY.draftFlushFailed)
            }
            receipt = touchReceipt(receipt, 'drafts_flushed')
            await writeReceipt(dataRoot, receipt)

            // stopAndDrain covers owned work drain + runtime close in the current supervisor.
            if (typeof ports.stopAndDrain !== 'function') throw missingAuthority('W1-A1')
            try {
                await ports.stopAndDrain()
            } catch {
                await safeUnfreeze(ports)
                receipt = touchReceipt(receipt, 'failed_before_drain', { reason: WORKSPACE_COPY.drainFailed })
                await writeReceipt(dataRoot, receipt)
                return refusal('drain_failed', WORKSPACE_COPY.drainFailed)
            }
            receipt = touchReceipt(receipt, 'work_drained')
            await writeReceipt(dataRoot, receipt)
            receipt = touchReceipt(receipt, 'old_runtime_closed', { oldRuntimeClosed: true })
            await writeReceipt(dataRoot, receipt)

            // Point of no silent rollback to the previous runtime without an explicit recovery path.
            if (typeof ports.bindAndStart !== 'function') throw missingAuthority('W1-A1')
            receipt = touchReceipt(receipt, 'target_starting')
            await writeReceipt(dataRoot, receipt)
            let started
            try {
                started = await ports.bindAndStart(toWorkspaceId)
            } catch (error) {
                if (error?.code === 'authority_missing') throw error
                receipt = touchReceipt(receipt, 'failed_after_drain', { reason: WORKSPACE_COPY.runtimeStartFailed })
                await writeReceipt(dataRoot, receipt)
                return refusal('runtime_start_failed', WORKSPACE_COPY.runtimeStartFailed)
            }

            if (typeof ports.verifyRuntimeIdentity !== 'function') throw missingAuthority('W1-A3')
            const verified = await ports.verifyRuntimeIdentity(toWorkspaceId)
            if (verified !== true || Number(started?.workspaceId) !== toWorkspaceId) {
                receipt = touchReceipt(receipt, 'failed_after_drain', { reason: WORKSPACE_COPY.identityMismatch })
                await writeReceipt(dataRoot, receipt)
                return refusal('identity_mismatch', WORKSPACE_COPY.identityMismatch)
            }
            receipt = touchReceipt(receipt, 'identity_verified')
            await writeReceipt(dataRoot, receipt)

            await writeSelection(dataRoot, {
                workspaceId: toWorkspaceId,
                publishedByReceiptId: receipt.receiptId,
                selectedAt: new Date().toISOString(),
            })
            receipt = touchReceipt(receipt, 'published', { reason: null })
            await writeReceipt(dataRoot, receipt)
            await safeUnfreeze(ports)

            const latest = await getWorkspace(dataRoot, installId, toWorkspaceId)
            return { ok: true, receipt, workspace: latest.workspace }
        } catch (error) {
            if (error?.code === 'authority_missing') {
                const rolled = touchReceipt(receipt, receipt.oldRuntimeClosed ? 'failed_after_drain' : 'failed_before_drain', {
                    reason: WORKSPACE_COPY.authorityMissing(error.authority),
                })
                await writeReceipt(dataRoot, rolled)
                if (!rolled.oldRuntimeClosed) await safeUnfreeze(ports)
                return refusal('authority_missing', WORKSPACE_COPY.authorityMissing(error.authority), error.authority)
            }
            const rolled = touchReceipt(receipt, receipt.oldRuntimeClosed ? 'failed_after_drain' : 'failed_before_drain', {
                reason: WORKSPACE_COPY.runtimeStartFailed,
            })
            await writeReceipt(dataRoot, rolled)
            if (!rolled.oldRuntimeClosed) await safeUnfreeze(ports)
            return refusal('runtime_start_failed', WORKSPACE_COPY.runtimeStartFailed)
        }
    }

    /**
     * Cold-launch contract helper. Read-only: reports which workspace launch()
     * should start. Root must call bindAndStart with this id — this function
     * never starts the runtime itself.
     */
    async function coldLaunchTarget() {
        const snapshot = await reconcile()
        if (snapshot.openReceipt && isAfterDrainPhase(snapshot.openReceipt.phase) && snapshot.openReceipt.phase !== 'published') {
            return {
                ok: false,
                code: 'busy',
                message: WORKSPACE_COPY.busy,
                workspaceId: snapshot.openReceipt.toWorkspaceId,
                receipt: snapshot.openReceipt,
            }
        }
        const workspaceId = Number(snapshot.selection.workspaceId) || LEGACY_WORKSPACE_ID
        const workspace = snapshot.catalog.workspaces.find(w => Number(w.workspaceId) === workspaceId)
            ?? snapshot.catalog.workspaces.find(w => Number(w.workspaceId) === LEGACY_WORKSPACE_ID)
        if (!workspace) {
            return { ok: false, code: 'not_found', message: WORKSPACE_COPY.notFound, workspaceId: LEGACY_WORKSPACE_ID }
        }
        if (workspace.pathStatus === 'missing') return { ok: false, code: 'path_missing', message: WORKSPACE_COPY.pathMissing, workspaceId: workspace.workspaceId }
        if (workspace.pathStatus === 'corrupt') return { ok: false, code: 'path_corrupt', message: WORKSPACE_COPY.pathCorrupt, workspaceId: workspace.workspaceId }
        if (workspace.pathStatus === 'foreign') return { ok: false, code: 'path_foreign', message: WORKSPACE_COPY.pathForeign, workspaceId: workspace.workspaceId }
        return { ok: true, workspaceId: workspace.workspaceId, workspace }
    }

    return { list, create, rename, switchTo, reconcile, coldLaunchTarget }
}

async function safeUnfreeze(ports) {
    try {
        if (typeof ports.unfreezeAdmissions === 'function') await ports.unfreezeAdmissions()
    } catch {
        // Unfreeze best-effort; next reconcile surfaces a stuck freeze via open receipt.
    }
}
