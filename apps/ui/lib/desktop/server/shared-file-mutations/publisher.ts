import { createHash } from 'node:crypto'
import { sharedMutationCallSchema, sharedMutationResultSchema, type SharedMutationCall, type SharedMutationResult } from '@rerun/contracts'
import { assertCanonicalSharedRoot, createSharedDocument, editSharedDocument, SharedMutationError, type SharedEditOutcome, type SharedWriteOutcome } from '../../../../../engine/src/desktop/shared-file-mutations/fs'
import { SharedMutationRefusal, type SharedMutationAuthority } from './authority'
import type { SharedReceiptKey, SharedReceiptRow, SharedReceiptStore } from './store'

export type SharedMutationIo = {
    create(root: string, path: string, content: string, access: { signal: AbortSignal; beforeCommit(): Promise<void> }): Promise<SharedWriteOutcome>
    edit(root: string, input: { path: string; oldString: string; newString: string; replaceAll?: boolean; expectedBytes: number; expectedSha256: string }, access: { signal: AbortSignal; beforeCommit(): Promise<void> }): Promise<SharedEditOutcome>
}

const realIo: SharedMutationIo = { create: createSharedDocument, edit: editSharedDocument }
const uncertain = (path: string): SharedMutationResult => ({
    status: 'uncertain', path, code: 'uncertain',
    message: 'No save acknowledgement is available. Inspect Shared files; this exact call will not be published again if it was claimed.',
})

function digestOf(call: SharedMutationCall): string {
    return createHash('sha256').update(JSON.stringify([call.workspaceId, call.engineAgentId, call.sessionId, call.runId, call.tool, call.arguments])).digest('hex')
}

function stored(outcome: SharedWriteOutcome | SharedEditOutcome): SharedMutationResult {
    const { committed, occurrences, ...result } = outcome as SharedWriteOutcome & SharedEditOutcome & { occurrences?: number }
    void committed
    void occurrences
    return sharedMutationResultSchema.parse(result)
}

export function createSharedMutationPublisher(store: SharedReceiptStore, authority: SharedMutationAuthority, io: SharedMutationIo = realIo) {
    const pending = new Map<string, { digest: string; result: Promise<SharedMutationResult> }>()
    return async (input: SharedMutationCall, stop: AbortSignal): Promise<SharedMutationResult> => {
        const call = sharedMutationCallSchema.parse(input)
        const signal = AbortSignal.any([stop, AbortSignal.timeout(30_000)])
        const allow = async () => {
            const current = await authority.current({ engineAgentId: call.engineAgentId, workspaceId: call.workspaceId }, signal)
            signal.throwIfAborted()
            if (current.state === 'deleted') throw new SharedMutationRefusal('owner_deleted', 'That coworker has been deleted.')
            if (current.state === 'disabled') throw new SharedMutationRefusal('owner_disabled', 'That coworker is disabled.')
            if (current.state === 'replaced') throw new SharedMutationRefusal('owner_replaced', 'That coworker was replaced.')
            if (!current.writeGrant) throw new SharedMutationRefusal('grant', 'Read shared files does not allow writing.')
            if (current.workspaceId !== call.workspaceId) throw new SharedMutationRefusal('stale_workspace', 'That workspace is not the open workspace.')
            const sharedRoot = await assertCanonicalSharedRoot(current.dataRoot, current.workspaceId, current.sharedRoot, signal)
            return { ...current, sharedRoot }
        }
        const opened = await allow()
        const path = call.arguments.path
        const digest = digestOf(call)
        const key: SharedReceiptKey = { workspaceId: opened.workspaceId, owner: opened.owner, runId: call.runId, callId: call.toolCallId }
        const mapKey = JSON.stringify([key.workspaceId, key.owner, key.runId, key.callId])
        const fromRow = (row: SharedReceiptRow): SharedMutationResult => {
            if (row.digest !== digest) throw new Error('Tool call identity was reused')
            if (!row.result) return uncertain(path)
            const parsed = sharedMutationResultSchema.safeParse(JSON.parse(row.result))
            if (!parsed.success || parsed.data.path !== path || parsed.data.status !== row.state) return uncertain(path)
            return parsed.data
        }
        const existing = pending.get(mapKey)
        if (existing) {
            if (existing.digest !== digest) throw new Error('Tool call identity was reused')
            try { return await existing.result } catch (error) { if (signal.aborted) return uncertain(path); throw error }
        }
        const work = async (): Promise<SharedMutationResult> => {
            const prior = await store.read(key)
            const again = await allow()
            if (again.owner !== opened.owner || again.launchNonce !== opened.launchNonce || again.sharedRoot !== opened.sharedRoot) {
                throw new SharedMutationRefusal('stale_workspace', 'That workspace is not the open workspace.')
            }
            if (prior) return fromRow(prior)
            const claimed = await store.claim(key, digest)
            if (!claimed) {
                const winner = await store.read(key)
                return winner ? fromRow(winner) : uncertain(path)
            }
            let committed = false
            try {
                const fresh = await allow()
                if (fresh.sharedRoot !== opened.sharedRoot || fresh.owner !== opened.owner) throw new SharedMutationRefusal('root_replaced', 'The shared folder was replaced.')
                const access = { signal, beforeCommit: async () => { await allow(); signal.throwIfAborted() } }
                const outcome = call.tool === 'shared_write'
                    ? await io.create(fresh.sharedRoot, call.arguments.path, 'content' in call.arguments ? call.arguments.content : '', access)
                    : await io.edit(fresh.sharedRoot, call.arguments as { path: string; oldString: string; newString: string; replaceAll?: boolean; expectedBytes: number; expectedSha256: string }, access)
                committed = outcome.committed
                const result = stored(outcome)
                const recorded = await store.finish(key, digest, result.status, JSON.stringify(result))
                return recorded ? result : uncertain(path)
            } catch (error) {
                if (committed) {
                    const result: SharedMutationResult = { status: 'saved', path, message: 'The shared file write finished. Inspect Shared files for the saved bytes.' }
                    const recorded = await store.finish(key, digest, 'saved', JSON.stringify(result)).catch(() => false)
                    return recorded ? result : uncertain(path)
                }
                if (error instanceof SharedMutationError && error.code !== 'uncertain' && error.code !== 'cancelled' && error.code !== 'root_replaced') {
                    const code = error.code === 'symlink' || error.code === 'oversized' || error.code === 'malformed' ? error.code : 'outside'
                    const result = sharedMutationResultSchema.parse({ status: 'refused', path, code, message: error.message })
                    const recorded = await store.finish(key, digest, 'refused', JSON.stringify(result)).catch(() => false)
                    return recorded ? result : uncertain(path)
                }
                const result = uncertain(path)
                await store.finish(key, digest, 'uncertain', JSON.stringify(result)).catch(() => false)
                if (error instanceof SharedMutationRefusal && !signal.aborted) throw error
                return result
            }
        }
        const result = Promise.resolve().then(work)
        pending.set(mapKey, { digest, result })
        const settled = () => { if (pending.get(mapKey)?.result === result) pending.delete(mapKey) }
        void result.then(settled, settled)
        try { return await result } catch (error) { if (signal.aborted) return uncertain(path); throw error }
    }
}
