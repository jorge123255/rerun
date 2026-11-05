import { describe, it, expect } from 'vitest'
import { subset, orderedDelegationResult, DELEGATION_LIMITS, createDelegationRuntime } from './runtime.js'
import type { DesktopDelegationSnapshot, DelegationHost, DelegationStore, Record, ReceiptStore, StopReceipt } from './types.js'

describe('desktop delegation confinement and ordered outcomes', () => {
    it('never widens parent grants and refuses sensitive or recursive tools', () => {
        expect(subset({ connectionId: 'connection', model: 'parent', tools: ['fs_read', 'delegate_tasks', 'call_agent', 'shell_exec', 'request_secret', 'fs_write', 'web_fetch'] }, { isolatedTool: t => ['fs_read', 'shell_exec', 'delegate_tasks', 'request_secret'].includes(t) })).toEqual(['fs_read'])
        expect(DELEGATION_LIMITS.workers).toBe(4)
    })
    it('renders input order with honest failures and empty answers', () => {
        const snapshot: DesktopDelegationSnapshot = { delegationId: 'd', revision: 'r', parentAgentId: 'a', parentSessionId: 's', parentRunId: 'r', toolCallId: 't', tasks: [
            { taskId: '1', title: 'First', status: 'error', steps: 0, toolCalls: 0, failures: 0, preview: '', calls: [], cleanup: 'blocked', error: 'Interrupted by restart' },
            { taskId: '2', title: 'Second', status: 'done', steps: 1, toolCalls: 0, failures: 0, preview: '', calls: [], cleanup: 'complete', result: '' },
        ] }
        expect(orderedDelegationResult(snapshot)).toBe('## Task 1 — First\n(error: Interrupted by restart)\n\n## Task 2 — Second\n(the sub-coworker returned no text)')
    })
})

function fixture() {
    const records = new Map<string, Record>(), receipts = new Map<string, StopReceipt>()
    const clone = <T,>(x: T): T => structuredClone(x)
    const store: DelegationStore = {
        async reserve(record) {
            const prior = [...records.values()].find(r => r.snapshot.toolCallId === record.snapshot.toolCallId)
            if (prior) return { record: clone(prior), created: false }
            records.set(record.snapshot.delegationId, clone(record)); return { record: clone(record), created: true }
        },
        async save(record, revision) {
            if (records.get(record.snapshot.delegationId)?.snapshot.revision !== revision) throw new Error('conflict')
            records.set(record.snapshot.delegationId, clone(record))
        },
        async read(id) { return clone(records.get(id) ?? null) },
        async list(sessionId) { return clone([...records.values()].filter(r => !sessionId || r.snapshot.parentSessionId === sessionId)) },
    }
    const receiptStore: ReceiptStore = { async read(id) { return receipts.get(id) ?? null }, async put(id, r) { receipts.set(id, r) } }
    let launches = 0, drains = 0, cleaned = 0
    const host: DelegationHost = {
        async current() { return { connectionId: 'connection', model: 'same-model', tools: ['fs_read'] } }, isolatedTool: t => t === 'fs_read',
        async allocate(_, taskId) { return { token: taskId, identity: 'exact-inode' } }, async recover() { return null },
        async create(_, input) {
            launches++
            return { settled: Promise.resolve(), async stop() {}, async run(progress) { await input.authorizeTool('fs_read'); await progress({ type: 'step' }); return input.task } }
        },
        async drain() { drains++ }, async admitOutputs() { return [] }, async cleanup() { cleaned++ }, publicText: (_, text) => text,
    }
    return { store, host, receiptStore, counts: () => ({ launches, drains, cleaned }) }
}
const source = { parentAgentId: 'owner', parentSessionId: 'session', parentRunId: 'run', toolCallId: 'tool' }
it('durably deduplicates an invocation and does not relaunch settled workers', async () => {
    const f = fixture(), runtime = createDelegationRuntime(f.store, f.host, f.receiptStore)
    await runtime.reconcile()
    const input = { tasks: [{ task: 'one' }, { task: 'two' }] }
    const first = await runtime.execute(source, input, new AbortController().signal)
    const replay = await runtime.execute(source, input, new AbortController().signal)
    expect(replay).toEqual(first)
    expect(first.tasks.map(t => t.result)).toEqual(['one', 'two'])
    expect(f.counts()).toEqual({ launches: 2, drains: 2, cleaned: 2 })
    await expect(runtime.execute(source, { tasks: [{ task: 'changed' }] }, new AbortController().signal)).rejects.toThrow('Invocation identity conflict')
})
it('reconciles uncertain work as interrupted, drains before cleanup, never replays it', async () => {
    const f = fixture()
    await f.store.reserve({ version: 1, digest: 'old', resources: [{ token: 'owned', identity: 'inode' }], outputs: [null], snapshot: { ...source, delegationId: 'd', revision: 'r', tasks: [{ taskId: 'task', title: 'unfinished', status: 'running', steps: 0, toolCalls: 0, failures: 0, calls: [], preview: '', cleanup: 'pending' }] } })
    const runtime = createDelegationRuntime(f.store, f.host, f.receiptStore)
    await runtime.reconcile()
    const [snapshot] = await runtime.list('session')
    expect(snapshot!.tasks[0]!.status).toBe('error')
    expect(snapshot!.tasks[0]!.cleanup).toBe('complete')
    expect(f.counts()).toEqual({ launches: 0, drains: 1, cleaned: 1 })
})
