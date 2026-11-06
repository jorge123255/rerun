import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
// Canonical I35 dependency at 052f6f66f8f8eaca27d5ea878d2cf3024e617dc0. Root integrates it.
import { getWorkspace } from '../workspaces/catalog.mjs'
import { workspaceDirectory, atomicPrivateJSON, readJSON } from '../workspaces/paths.mjs'
import { remoteAddress } from './network.mjs'
import { VERSION, UUID, LIMITS, identity, sameOwner, publicReceipt, publicConnection, refusal, actor as validateActor } from './protocol.mjs'
const phases = new Set(['accepted', 'admissions_frozen', 'drafts_flushed', 'work_drained', 'old_runtime_closing', 'old_runtime_closed', 'target_starting', 'identity_verified', 'published', 'failed_before_drain', 'failed_after_drain', 'rolled_back', 'cancelled'])
export function createRemoteMachineStore({ dataRoot, installId, workspaceId }) {
    const owner = { installId, workspaceId }, path = resolve(workspaceDirectory(dataRoot, workspaceId), 'remote-machine.json')
    let gate = Promise.resolve()
    async function owned() {
        const result = await getWorkspace(dataRoot, installId, workspaceId)
        if (!result.workspace || result.workspace.pathStatus !== 'ready') throw refusal('stale', 'This workspace is unavailable or belongs to another install.')
    }
    const empty = () => ({ version: VERSION, ...owner, revision: 'unconfigured', connection: null, selected: false, activeReceipt: null, operations: [] })
    function validate(value) {
        if (!value || value.version !== VERSION || !sameOwner(value, owner) || value.revision !== 'unconfigured' && !UUID.test(value.revision)
            || typeof value.selected !== 'boolean' || value.selected && (!value.connection || !value.activeReceipt) || !Array.isArray(value.operations) || value.operations.length > LIMITS.receipts) throw refusal('unavailable', 'Saved server state needs recovery.')
        const connection = record => {
            if (!record || !UUID.test(record.connectionId) || !UUID.test(record.revision) || record.workspaceId !== workspaceId || typeof record.address !== 'string'
                || record.address.length > 2048 || remoteAddress(record.address) !== record.address || record.sealedKey !== null && (typeof record.sealedKey !== 'string' || record.sealedKey.length > 16384)) throw refusal('unavailable', 'Saved server configuration needs recovery.')
            if (record.identity) identity(record.identity)
            const h = record.health
            if (!h || !['not_checked', 'connected', 'unreachable', 'auth_needed', 'identity_changed', 'unsupported', 'cancelled'].includes(h.state)
                || h.checkedAt !== null && !Number.isFinite(Date.parse(h.checkedAt)) || h.commit !== null && (typeof h.commit !== 'string' || h.commit.length > 128)
                || h.activeAgents !== null && (!Number.isSafeInteger(h.activeAgents) || h.activeAgents < 0 || h.activeAgents > 1000000)
                || h.reason !== null && (typeof h.reason !== 'string' || h.reason.length > 400)) throw refusal('unavailable', 'Saved server health needs recovery.')
        }
        if (value.connection) { connection(value.connection); identity(value.connection.identity); if (!value.connection.sealedKey || !/^[0-9a-f]{64}$/.test(value.connection.tlsPin)) throw refusal('unavailable', 'Saved server identity needs recovery.') }
        const seen = new Set()
        for (const op of value.operations) {
            const r = op.receipt
            if (!r || r.version !== 1 || !sameOwner(r, owner) || !UUID.test(r.requestId) || !UUID.test(r.receiptId) || !UUID.test(r.revision) || seen.has(r.requestId)
                || !UUID.test(r.connectionId) || !UUID.test(r.configurationRevision) || !phases.has(r.phase) || typeof r.requiresRecovery !== 'boolean'
                || !Number.isInteger(r.effectGeneration) || r.effectGeneration < 0 || r.effectGeneration > 8 || !Array.isArray(op.history) || op.history.length > 8
                || typeof r.closeAttempted !== 'boolean' || typeof op.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(op.fingerprint)
                || !['pair', 'replace', 'select', 'remove', 'health'].includes(r.kind) || !op.effects || typeof op.effects !== 'object') throw refusal('unavailable', 'Saved server operation identities could not be verified.')
            if (r.expectedRevision !== 'unconfigured' && !UUID.test(r.expectedRevision) || !Number.isFinite(Date.parse(r.createdAt)) || !Number.isFinite(Date.parse(r.updatedAt))
                || r.reason !== null && (typeof r.reason !== 'string' || r.reason.length > 400)) throw refusal('unavailable', 'Saved server receipt metadata needs recovery.')
            validateActor(op.acceptedBy); if (op.recoveredBy) validateActor(op.recoveredBy)
            if (!sameOwner(op.acceptedBy, owner) || op.recoveredBy && !sameOwner(op.recoveredBy, owner)) throw refusal('unavailable', 'Saved server actor belongs to another workspace.')
            seen.add(r.requestId)
            if (op.candidate) connection(op.candidate)
        }
        if (value.operations.filter(op => op.receipt.requiresRecovery).length > 1) throw refusal('unavailable', 'More than one server transition needs recovery.')
        return value
    }
    async function read() {
        await owned()
        try {
            const info = await lstat(path)
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 2_000_000) throw refusal('unavailable', 'Saved server state is not a private regular file.')
            return validate(await readJSON(path))
        } catch (error) { if (error.code === 'ENOENT') return empty(); throw error }
    }
    async function mutate(change) {
        const work = gate.then(async () => {
            const state = await read(), before = state.revision
            const result = await change(state)
            state.revision = randomUUID(); validate(state)
            if (Buffer.byteLength(JSON.stringify(state)) > 1_900_000) throw refusal('storage_full', 'Server recovery storage is full. Existing request identities were preserved.')
            await owned()
            if ((await read()).revision !== before) throw refusal('stale', 'The saved server changed in another owner.')
            await atomicPrivateJSON(path, state)
            return result
        })
        gate = work.catch(() => {})
        return work
    }
    function snapshot(state, actor) {
        return { version: VERSION, actor, revision: state.revision, connection: publicConnection(state.connection), selected: state.selected, runtimeState: 'unknown', activeReceipt: publicReceipt(state.activeReceipt ? { receipt: state.activeReceipt } : null),
            openReceipt: publicReceipt(state.operations.find(op => op.receipt.requiresRecovery)) }
    }
    return { read, mutate, snapshot, owned }
}
