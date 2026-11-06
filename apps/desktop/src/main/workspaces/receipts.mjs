import { readdir } from 'node:fs/promises'
import {
    CONTRACT_VERSION,
    atomicPrivateJSON,
    ensureWorkspacesLayout,
    pathExists,
    readJSON,
    switchReceiptPath,
    switchesRoot,
} from './paths.mjs'

const TERMINAL = new Set(['published', 'failed_before_drain', 'failed_after_drain', 'rolled_back', 'cancelled'])
const AFTER_DRAIN = new Set(['old_runtime_closed', 'target_starting', 'identity_verified', 'failed_after_drain', 'published'])

export function isTerminalPhase(phase) {
    return TERMINAL.has(phase)
}

export function isAfterDrainPhase(phase) {
    return AFTER_DRAIN.has(phase)
}

export async function writeReceipt(dataRoot, receipt) {
    await ensureWorkspacesLayout(dataRoot)
    await atomicPrivateJSON(switchReceiptPath(dataRoot, receipt.receiptId), {
        version: CONTRACT_VERSION,
        receiptId: receipt.receiptId,
        requestId: receipt.requestId,
        fromWorkspaceId: Number(receipt.fromWorkspaceId),
        toWorkspaceId: Number(receipt.toWorkspaceId),
        phase: receipt.phase,
        installId: receipt.installId,
        createdAt: receipt.createdAt,
        updatedAt: receipt.updatedAt,
        reason: receipt.reason ?? null,
        admissionsFrozen: Boolean(receipt.admissionsFrozen),
        oldRuntimeClosed: Boolean(receipt.oldRuntimeClosed),
    })
}

export async function readReceipt(dataRoot, receiptId) {
    const path = switchReceiptPath(dataRoot, receiptId)
    if (!(await pathExists(path))) return null
    return readJSON(path)
}

export async function listReceipts(dataRoot) {
    await ensureWorkspacesLayout(dataRoot)
    const names = await readdir(switchesRoot(dataRoot))
    const receipts = []
    for (const name of names) {
        if (!name.endsWith('.json')) continue
        try {
            receipts.push(await readJSON(switchReceiptPath(dataRoot, name.slice(0, -5))))
        } catch {
            // Corrupt receipt files are reported by reconciliation; skip unreadable names.
        }
    }
    return receipts.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

/** Non-effectful: returns the newest non-terminal receipt, if any. */
export async function findOpenReceipt(dataRoot) {
    const receipts = await listReceipts(dataRoot)
    for (let i = receipts.length - 1; i >= 0; i--) {
        if (!isTerminalPhase(receipts[i].phase)) return receipts[i]
    }
    return null
}

export async function findReceiptByRequestId(dataRoot, requestId) {
    const receipts = await listReceipts(dataRoot)
    return receipts.find(r => r.requestId === requestId) ?? null
}

export function touchReceipt(receipt, phase, patch = {}) {
    return {
        ...receipt,
        ...patch,
        phase,
        updatedAt: new Date().toISOString(),
        admissionsFrozen: patch.admissionsFrozen ?? receipt.admissionsFrozen ?? false,
        oldRuntimeClosed: patch.oldRuntimeClosed ?? receipt.oldRuntimeClosed ?? false,
    }
}
