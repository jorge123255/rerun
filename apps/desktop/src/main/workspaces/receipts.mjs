import { readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { CONTRACT_VERSION, atomicPrivateJSON, inspectWorkspacesLayout, pathExists, readJSON, switchReceiptPath, switchesRoot, UUID, validWorkspaceId, persistenceError } from './paths.mjs'
const TERMINAL = new Set(['published', 'failed_before_drain', 'rolled_back', 'cancelled'])
const AFTER_DRAIN = new Set(['old_runtime_closing', 'work_drained', 'old_runtime_closed', 'target_starting', 'identity_verified', 'failed_after_drain', 'published'])
const PHASES = new Set(['accepted', 'admissions_frozen', 'drafts_flushed', ...TERMINAL, ...AFTER_DRAIN])
export const isTerminalPhase = phase => TERMINAL.has(phase)
export const isAfterDrainPhase = phase => AFTER_DRAIN.has(phase)
export function switchFingerprint(receipt) { return createHash('sha256').update(JSON.stringify(['switch', receipt.installId, receipt.requestId, receipt.fromWorkspaceId, receipt.toWorkspaceId])).digest('hex') }
function validate(receipt, installId) {
    if (!receipt || receipt.version !== CONTRACT_VERSION || !UUID.test(receipt.receiptId) || !UUID.test(receipt.requestId) || !UUID.test(receipt.installId)
        || (installId && receipt.installId !== installId) || !validWorkspaceId(receipt.fromWorkspaceId) || !validWorkspaceId(receipt.toWorkspaceId)
        || !PHASES.has(receipt.phase) || !Number.isFinite(Date.parse(receipt.createdAt)) || !Number.isFinite(Date.parse(receipt.updatedAt))
        || typeof receipt.admissionsFrozen !== 'boolean' || typeof receipt.oldRuntimeClosed !== 'boolean'
        || (receipt.reason !== null && (typeof receipt.reason !== 'string' || receipt.reason.length > 400))
        || receipt.fingerprint !== switchFingerprint(receipt)) throw persistenceError('Workspace transition needs recovery.')
    return receipt
}
export function publicReceipt(receipt) { const { fingerprint: _fingerprint, ...result } = receipt; return result }
export async function writeReceipt(dataRoot, receipt) {
    const saved = validate({ ...receipt, fingerprint: receipt.fingerprint ?? switchFingerprint(receipt) }, receipt.installId)
    await atomicPrivateJSON(switchReceiptPath(dataRoot, saved.receiptId), saved)
}
export async function readReceipt(dataRoot, receiptId, installId) {
    if (!await inspectWorkspacesLayout(dataRoot)) throw persistenceError()
    const path = switchReceiptPath(dataRoot, receiptId)
    if (!await pathExists(path)) return null
    return validate(await readJSON(path), installId)
}
export async function listReceipts(dataRoot, installId) {
    if (!await inspectWorkspacesLayout(dataRoot)) throw persistenceError()
    const names = await readdir(switchesRoot(dataRoot)), receipts = [], requests = new Set()
    for (const name of names) {
        if (!name.endsWith('.json')) continue
        try {
            const receipt = validate(await readJSON(switchReceiptPath(dataRoot, name.slice(0, -5))), installId)
            if (`${receipt.receiptId}.json` !== name || requests.has(receipt.requestId)) throw persistenceError()
            requests.add(receipt.requestId); receipts.push(receipt)
        } catch { throw persistenceError('Workspace transition records could not be verified.') }
    }
    return receipts.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.receiptId.localeCompare(b.receiptId))
}
export async function findOpenReceipt(dataRoot, installId) {
    const pending = (await listReceipts(dataRoot, installId)).filter(receipt => !isTerminalPhase(receipt.phase))
    if (pending.length > 1) throw persistenceError('More than one workspace transition needs recovery.')
    return pending[0] ?? null
}
export async function findReceiptByRequestId(dataRoot, requestId, installId) { return (await listReceipts(dataRoot, installId)).find(receipt => receipt.requestId === requestId) ?? null }
export function touchReceipt(receipt, phase, patch = {}) { return { ...receipt, ...patch, phase, updatedAt: new Date().toISOString(), admissionsFrozen: patch.admissionsFrozen ?? receipt.admissionsFrozen ?? false, oldRuntimeClosed: patch.oldRuntimeClosed ?? receipt.oldRuntimeClosed ?? false } }
