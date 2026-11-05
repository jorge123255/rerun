import { describe, expect, it } from 'vitest'
import { createDelegationRuntime, orderedDelegationResult } from './runtime.js'
import type { Authority, DelegationHost, DelegationStore, Record, ReceiptStore, StopReceipt } from './types.js'

const source = { parentAgentId: 'owner', parentSessionId: 'session', parentRunId: 'run', toolCallId: 'tool' }
const authority: Authority = { connectionId: 'connection', model: 'model', tools: ['fs_read'] }
const deferred = <T,>() => {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
async function until(predicate: () => boolean) {
    for (let attempt = 0; attempt < 30; attempt++) {
        if (predicate()) return
        await tick()
    }
    throw new Error('Condition was not reached')
}

function memoryStore() {
    const records = new Map<string, Record>()
    const clone = <T,>(value: T): T => structuredClone(value)
    const store: DelegationStore = {
        async reserve(record) {
            const prior = [...records.values()].find(row => row.snapshot.parentAgentId === record.snapshot.parentAgentId && row.snapshot.parentSessionId === record.snapshot.parentSessionId && row.snapshot.parentRunId === record.snapshot.parentRunId && row.snapshot.toolCallId === record.snapshot.toolCallId)
            if (prior) return { record: clone(prior), created: false }
            records.set(record.snapshot.delegationId, clone(record))
            return { record: clone(record), created: true }
        },
        async save(record, expectedRevision) {
            if (records.get(record.snapshot.delegationId)?.snapshot.revision !== expectedRevision) throw new Error('revision conflict')
            records.set(record.snapshot.delegationId, clone(record))
        },
        async read(id) { return clone(records.get(id) ?? null) },
        async list(sessionId) { return clone([...records.values()].filter(row => !sessionId || row.snapshot.parentSessionId === sessionId)) },
    }
    return { store, records }
}

function receipts() {
    const rows = new Map<string, StopReceipt>()
    const store: ReceiptStore = { async reserve(id, receipt) { const prior = rows.get(id); if (prior && prior.digest !== receipt.digest) throw new Error('conflict'); if (!prior) rows.set(id, structuredClone(receipt)); return prior ?? receipt }, async read(id) { return rows.get(id) ?? null }, async put(id, receipt) { rows.set(id, structuredClone(receipt)) } }
    return store
}

function hostWith(overrides: Partial<DelegationHost> = {}) {
    const calls = { launches: 0, drains: 0, cleanups: 0, publications: 0 }
    const host: DelegationHost = {
        async current() { return authority },
        isolatedTool: tool => tool === 'fs_read',
        async allocate(_, taskId) { return { token: taskId, identity: `inode-${taskId}` } },
        async create(_, input) {
            calls.launches++
            return { settled: Promise.resolve(), async stop() {}, async run(progress) {
                await input.authorizeTool('fs_read')
                await progress({ type: 'step' })
                return input.task
            } }
        },
        async recover() { return null },
        async drain() { calls.drains++ },
        async admitOutputs() { calls.publications++; return [] },
        async cleanup() { calls.cleanups++ },
        publicText: (_, text) => text,
        ...overrides,
    }
    return { host, calls }
}

async function ready(store: DelegationStore, host: DelegationHost, receiptStore = receipts()) {
    const runtime = createDelegationRuntime(store, host, receiptStore)
    await runtime.reconcile()
    return runtime
}

describe('bounded scheduling and durable progress', () => {
    it('runs at most four workers, accumulates real failures and preserves input order and output ownership', async () => {
        const { store } = memoryStore()
        const pending = new Map<string, ReturnType<typeof deferred<string>>>()
        let active = 0
        let maximum = 0
        const published: string[] = []
        const { host } = hostWith({
            async create(_, input) {
                active++; maximum = Math.max(maximum, active)
                const wait = deferred<string>()
                pending.set(input.task, wait)
                return { settled: Promise.resolve(), async stop() { active--; wait.reject(new Error('stopped')) }, async run(progress) {
                    try {
                        await progress({ type: 'step' })
                        await progress({ type: 'call', tool: 'fs_read', failed: true })
                        await progress({ type: 'call', tool: 'fs_read' })
                        return await wait.promise
                    } finally { active-- }
                } }
            },
            async admitOutputs(_, source, taskId) {
                published.push(taskId)
                return [{ identity: `output-${taskId}`, hash: `hash-${taskId}` }]
            },
        })
        const runtime = await ready(store, host)
        const result = runtime.execute(source, { tasks: ['one', 'two', 'three', 'four', 'five', 'six'].map(task => ({ task })) }, new AbortController().signal)
        await until(() => pending.size === 4)
        expect(maximum).toBe(4)
        expect([...pending.keys()]).toEqual(['one', 'two', 'three', 'four'])
        pending.get('three')!.resolve('third')
        pending.get('one')!.resolve('first')
        pending.get('two')!.resolve('second')
        pending.get('four')!.resolve('fourth')
        await until(() => pending.size === 6)
        pending.get('five')!.resolve('fifth')
        pending.get('six')!.resolve('sixth')
        const snapshot = await result
        expect(snapshot.tasks.map(task => task.result)).toEqual(['first', 'second', 'third', 'fourth', 'fifth', 'sixth'])
        expect(snapshot.tasks[0]).toMatchObject({ steps: 1, toolCalls: 2, failures: 1, cleanup: 'complete' })
        expect(published).toHaveLength(6)
        expect(orderedDelegationResult(snapshot)).toContain('## Task 3 — three\nthird')
    })

    it('reconciles a concurrent duplicate invocation and rejects a changed body without another launch', async () => {
        const { store } = memoryStore()
        const wait = deferred<string>()
        const { host, calls } = hostWith({ async create() { calls.launches++; return { settled: Promise.resolve(), async stop() {}, async run() { return wait.promise } } } })
        const runtime = await ready(store, host)
        const input = { tasks: [{ task: 'only' }] }
        const first = runtime.execute(source, input, new AbortController().signal)
        const duplicate = runtime.execute(source, input, new AbortController().signal)
        await tick()
        expect(calls.launches).toBe(1)
        wait.resolve('answer')
        expect(await first).toEqual(await duplicate)
        await expect(runtime.execute(source, { tasks: [{ task: 'changed' }] }, new AbortController().signal)).rejects.toThrow('Invocation identity conflict')
        expect(calls.launches).toBe(1)
    })

    it('refuses revoked admission before a reservation and fails a changed execution model honestly', async () => {
        const revoked = memoryStore()
        const { host: denied } = hostWith({ async current() { throw new Error('delegation grant revoked') } })
        const deniedRuntime = createDelegationRuntime(revoked.store, denied, receipts())
        await deniedRuntime.reconcile()
        await expect(deniedRuntime.execute(source, { tasks: [{ task: 'no' }] }, new AbortController().signal)).rejects.toThrow('delegation grant revoked')
        expect(await revoked.store.list()).toEqual([])

        const { store } = memoryStore()
        let reads = 0
        const { host } = hostWith({ async current() { reads++; return reads === 1 ? authority : { ...authority, connectionId: 'changed' } } })
        const runtime = await ready(store, host)
        const snapshot = await runtime.execute(source, { tasks: [{ task: 'no fallback' }] }, new AbortController().signal)
        expect(snapshot.tasks[0]?.status).toBe('error')
        expect(snapshot.tasks[0]?.result).toBeUndefined()
    })

    it('fails provider startup without a fabricated answer and cleans only admitted resources', async () => {
        const { store } = memoryStore()
        const { host, calls } = hostWith({ async create() { calls.launches++; throw new Error('provider missing') } })
        const runtime = await ready(store, host)
        const snapshot = await runtime.execute(source, { tasks: [{ task: 'no provider' }] }, new AbortController().signal)
        expect(snapshot.tasks[0]).toMatchObject({ status: 'error', cleanup: 'complete' })
        expect(snapshot.tasks[0].result).toBeUndefined()
        expect(calls).toMatchObject({ launches: 1, publications: 1, drains: 1, cleanups: 1 })
    })
})

describe('exact cancellation and partial outcomes', () => {
    it('stops a queued fifth sibling without cancelling four active tasks, then stops only the selected active task', async () => {
        const { store } = memoryStore()
        const waits = new Map<string, ReturnType<typeof deferred<string>>>()
        const { host } = hostWith({ async create(_, input) {
            const wait = deferred<string>(); waits.set(input.task, wait)
            return { settled: Promise.resolve(), async stop() { wait.resolve('late result') }, async run(progress) {
                await progress({ type: 'text', text: 'partial active work' })
                return wait.promise
            } }
        } })
        const runtime = await ready(store, host)
        const executing = runtime.execute(source, { tasks: ['active','two','three','four','queued'].map(task => ({task})) }, new AbortController().signal)
        await until(() => waits.size === 4); await tick()
        const [current] = await runtime.list('session'), queued = current!.tasks[4]!
        expect(queued.status).toBe('queued')
        const stopped = await runtime.stop(source, { operation: 'stop-task', requestId: crypto.randomUUID(), delegationId: current!.delegationId, taskId: queued.taskId, expectedRevision: current!.revision })
        expect(stopped.tasks[4]).toMatchObject({ status: 'stopped', cleanup: 'complete' })
        expect(stopped.tasks.slice(0,4).every(task => task.status === 'running')).toBe(true)
        await runtime.stop(source, { operation: 'stop-task', requestId: crypto.randomUUID(), delegationId: current!.delegationId, taskId: current!.tasks[0]!.taskId, expectedRevision: stopped.revision })
        for (const name of ['two','three','four']) waits.get(name)!.resolve(name)
        const snapshot = await executing
        expect(snapshot.tasks[0]).toMatchObject({ status: 'stopped', result: 'partial active work', partial: true })
        expect(snapshot.tasks.map(task => task.status)).toEqual(['stopped','done','done','done','stopped'])
        expect(waits.has('queued')).toBe(false)
    })

    it('parent cancellation stops active and queued work and preserves bounded partial output', async () => {
        const { store } = memoryStore()
        const parent = new AbortController()
        const { host } = hostWith({ async create() {
            return { settled: Promise.resolve(), async stop() {}, async run(progress) {
                await progress({ type: 'text', text: 'kept partial answer' })
                return new Promise<string>(() => {})
            } }
        } })
        const runtime = await ready(store, host)
        const executing = runtime.execute(source, { tasks: ['active','two','three','four','never admitted'].map(task => ({task})) }, parent.signal)
        await tick(); await tick()
        parent.abort()
        const snapshot = await executing
        expect(snapshot.tasks.map(task => task.status)).toEqual(['stopped', 'stopped', 'stopped', 'stopped', 'stopped'])
        expect(snapshot.tasks[0]).toMatchObject({ result: 'kept partial answer', partial: true })
        expect(orderedDelegationResult(snapshot)).toContain('Partial output:\nkept partial answer')
        expect(snapshot.tasks[4].startedAt).toBeUndefined()
    })

    it('rejects a wrong parent, task or revision without touching another lifecycle', async () => {
        const { store } = memoryStore()
        const { host } = hostWith()
        const runtime = await ready(store, host)
        const snapshot = await runtime.execute(source, { tasks: [{ task: 'settled' }] }, new AbortController().signal)
        const request = { operation: 'stop-task' as const, requestId: crypto.randomUUID(), delegationId: snapshot.delegationId, taskId: snapshot.tasks[0]!.taskId, expectedRevision: snapshot.revision }
        await expect(runtime.stop({ ...source, parentSessionId: 'other' }, request)).rejects.toThrow('Delegation owner mismatch')
        await expect(runtime.stop(source, { ...request, taskId: crypto.randomUUID() })).rejects.toThrow()
        await expect(runtime.stop(source, { ...request, expectedRevision: crypto.randomUUID() })).rejects.toThrow('Delegation revision conflict')
    })
})

describe('restart, shutdown and resource replacement', () => {
    it('recovers and admits exact outputs before draining without replaying uncertain work', async () => {
        const { store } = memoryStore()
        await store.reserve({ version: 1, digest: 'old', resources: [{ token: 'owned', identity: 'inode' }], outputs: [null], snapshot: { ...source, delegationId: crypto.randomUUID(), revision: crypto.randomUUID(), tasks: [{ taskId: crypto.randomUUID(), title: 'unfinished', status: 'running', steps: 1, toolCalls: 0, failures: 0, calls: [], preview: 'partial', cleanup: 'pending' }] } })
        const resource = { token: 'owned', identity: 'inode' }
        const { host, calls } = hostWith({ async recover() { return resource }, async admitOutputs() { calls.publications++; return [{ identity: 'published', hash: 'sha256' }] } })
        const runtime = createDelegationRuntime(store, host, receipts())
        await runtime.reconcile()
        const [snapshot] = await runtime.list('session')
        expect(snapshot!.tasks[0]).toMatchObject({ status: 'error', result: 'partial', partial: true, cleanup: 'complete' })
        expect(calls).toMatchObject({ launches: 0, publications: 1, drains: 1, cleanups: 1 })
    })

    it('blocks cleanup when output admission or replacement validation fails', async () => {
        const { store } = memoryStore()
        await store.reserve({ version: 1, digest: 'old', resources: [{ token: 'owned', identity: 'old-inode' }], outputs: [null], snapshot: { ...source, delegationId: crypto.randomUUID(), revision: crypto.randomUUID(), tasks: [{ taskId: crypto.randomUUID(), title: 'unfinished', status: 'running', steps: 0, toolCalls: 0, failures: 0, calls: [], preview: '', cleanup: 'pending' }] } })
        const { host, calls } = hostWith({ async recover() { return { token: 'owned', identity: 'old-inode' } }, async admitOutputs() { throw new Error('output changed') }, async cleanup() { throw new Error('replacement inode') } })
        const runtime = createDelegationRuntime(store, host, receipts())
        await runtime.reconcile()
        const [snapshot] = await runtime.list('session')
        expect(snapshot!.tasks[0].cleanup).toBe('blocked')
        expect(calls.cleanups).toBe(0)
    })

    it('shutdown aborts the parent scope, prevents later admission and waits for the active execution', async () => {
        const { store } = memoryStore()
        const { host } = hostWith({ async create() { return { settled: Promise.resolve(), async stop() {}, async run() { return new Promise<string>(() => {}) } } } })
        const runtime = await ready(store, host)
        const executing = runtime.execute(source, { tasks: [{ task: 'active' }, { task: 'queued' }] }, new AbortController().signal)
        await tick(); await tick()
        await runtime.shutdown()
        const snapshot = await executing
        expect(snapshot.tasks.map(task => task.status)).toEqual(['stopped', 'stopped'])
        await expect(runtime.execute(source, { tasks: [{ task: 'later' }] }, new AbortController().signal)).rejects.toThrow()
    })
})

describe('input confinement and receipt identity', () => {
    it('passes only explicit task/context, pinned connection/model and certified tools without secret or history objects', async () => {
        const { store } = memoryStore()
        let seen: Parameters<DelegationHost['create']>[1] | undefined
        const { host } = hostWith({ async create(_, input) {
            seen = input
            return { settled: Promise.resolve(), async stop() {}, async run() { return 'done' } }
        } })
        const runtime = await ready(store, host)
        await runtime.execute(source, { tasks: [{ task: 'explicit task', context: 'explicit context' }] }, new AbortController().signal)
        expect(seen).toBeDefined()
        expect(Object.keys(seen!).sort()).toEqual(['authorizeTool', 'connectionId', 'context', 'model', 'signal', 'task', 'tools'])
        expect(seen).toMatchObject({ connectionId: 'connection', model: 'model', task: 'explicit task', context: 'explicit context', tools: ['fs_read'] })
        expect(seen).not.toHaveProperty('env')
        expect(seen).not.toHaveProperty('keys')
        expect(seen).not.toHaveProperty('soul')
        expect(seen).not.toHaveProperty('history')
    })

    it('rejects malformed and oversized plans before reservation rather than truncating them', async () => {
        const { store } = memoryStore()
        const { host } = hostWith()
        const runtime = await ready(store, host)
        await expect(runtime.execute(source, { tasks: [] }, new AbortController().signal)).rejects.toThrow('Delegation input exceeds limits')
        await expect(runtime.execute(source, { tasks: [{ task: '' }] }, new AbortController().signal)).rejects.toThrow('Delegation input exceeds limits')
        await expect(runtime.execute(source, { tasks: [{ task: 'x'.repeat(32_001) }] }, new AbortController().signal)).rejects.toThrow('Delegation input exceeds limits')
        await expect(runtime.execute(source, { tasks: Array.from({ length: 33 }, () => ({ task: 'bounded' })) }, new AbortController().signal)).rejects.toThrow('Delegation input exceeds limits')
        expect(await store.list()).toEqual([])
    })

    it('keeps replacement cleanup blocked and replays only the exact Stop receipt', async () => {
        const { store } = memoryStore()
        await store.reserve({ version: 1, digest: 'old', resources: [{ token: 'owned', identity: 'old-inode' }], outputs: [[]], snapshot: { ...source, delegationId: crypto.randomUUID(), revision: crypto.randomUUID(), tasks: [{ taskId: crypto.randomUUID(), title: 'unfinished', status: 'running', steps: 0, toolCalls: 0, failures: 0, calls: [], preview: '', cleanup: 'pending' }] } })
        const { host, calls } = hostWith({ async recover() { return { token: 'owned', identity: 'old-inode' } }, async cleanup() { calls.cleanups++; throw new Error('replacement inode') } })
        const runtime = createDelegationRuntime(store, host, receipts())
        await runtime.reconcile()
        const [snapshot] = await runtime.list('session')
        expect(snapshot!.tasks[0].cleanup).toBe('blocked')
        expect(calls.cleanups).toBe(1)

        const settledStore = memoryStore()
        const settledHost = hostWith()
        const settledRuntime = await ready(settledStore.store, settledHost.host)
        const settled = await settledRuntime.execute(source, { tasks: [{ task: 'done' }] }, new AbortController().signal)
        const request = { operation: 'stop-task' as const, requestId: crypto.randomUUID(), delegationId: settled.delegationId, taskId: settled.tasks[0]!.taskId, expectedRevision: settled.revision }
        const first = await settledRuntime.stop(source, request)
        expect(await settledRuntime.stop(source, request)).toEqual(first)
        await expect(settledRuntime.stop(source, { ...request, taskId: crypto.randomUUID() })).rejects.toThrow('Stop identity conflict')
    })
})
