import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Record as DelegationRecord, StopReceipt } from '../../../../../engine/src/desktop/delegation/types'
import { delegationMigrationSql, delegationReceipts, delegationStore } from './store'

let root: string
let db: Client
const connect = () => createClient({ url: `file:${join(root, 'delegation.sqlite')}` })
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-delegation-store-'))
    db = connect()
    await db.executeMultiple(delegationMigrationSql.join(';'))
})
afterEach(async () => { db?.close(); if (root) await rm(root, { recursive: true, force: true }) })

function record(session = 'parent-chat'): DelegationRecord {
    return {
        version: 1, digest: 'a'.repeat(64), resources: [null, null], outputs: [null, null],
        snapshot: {
            delegationId: crypto.randomUUID(), revision: crypto.randomUUID(), parentAgentId: 'owner',
            parentSessionId: session, parentRunId: 'parent-run', toolCallId: 'delegate-tool',
            tasks: ['First', 'Second'].map(title => ({ taskId: crypto.randomUUID(), title, status: 'queued', steps: 0, toolCalls: 0, failures: 0, preview: '', calls: [], cleanup: 'pending' })),
        },
    }
}
function intent(saved: DelegationRecord): StopReceipt {
    return {
        digest: 'b'.repeat(64), source: { parentAgentId: saved.snapshot.parentAgentId, parentSessionId: saved.snapshot.parentSessionId },
        request: { operation: 'stop-task', requestId: crypto.randomUUID(), delegationId: saved.snapshot.delegationId, taskId: saved.snapshot.tasks[0]!.taskId, expectedRevision: saved.snapshot.revision },
    }
}

test('a source reservation is unique and each chat reads only its own history', async () => {
    const store = delegationStore(db), first = record(), duplicate = record(), sibling = record('other-chat')
    expect(await store.reserve(first)).toEqual({ created: true, record: first })
    expect(await store.reserve(duplicate)).toEqual({ created: false, record: first })
    await store.reserve(sibling)
    expect(await store.list(first.snapshot.parentSessionId)).toEqual([first])
    expect(await store.list(sibling.snapshot.parentSessionId)).toEqual([sibling])
    expect(await store.read(duplicate.snapshot.delegationId)).toBeNull()
})

test('record updates use the exact revision and persist across database reopen', async () => {
    const store = delegationStore(db), first = record()
    await store.reserve(first)
    const next = structuredClone(first)
    next.snapshot.revision = crypto.randomUUID()
    next.snapshot.tasks[0]!.status = 'running'
    await store.save(next, first.snapshot.revision)
    const stale = structuredClone(first)
    stale.snapshot.revision = crypto.randomUUID()
    await expect(store.save(stale, first.snapshot.revision)).rejects.toThrow('revision conflict')
    db.close(); db = connect()
    expect(await delegationStore(db).read(first.snapshot.delegationId)).toEqual(next)
})

test.each(['owner', 'session', 'revision', 'task'] as const)('Stop refuses an unowned or changed %s before reserving intent', async changed => {
    const saved = record(), receipt = intent(saved)
    await delegationStore(db).reserve(saved)
    if (changed === 'owner') receipt.source.parentAgentId = 'other-owner'
    if (changed === 'session') receipt.source.parentSessionId = 'other-chat'
    if (changed === 'revision') receipt.request.expectedRevision = crypto.randomUUID()
    if (changed === 'task') receipt.request.taskId = crypto.randomUUID()
    await expect(delegationReceipts(db).reserve(receipt.request.requestId, receipt)).rejects.toThrow('reservation changed')
    expect(await delegationReceipts(db).read(receipt.request.requestId)).toBeNull()
})

test('a durable Stop intent survives progress and restart without redirecting to a sibling task', async () => {
    const saved = record(), receipt = intent(saved), store = delegationStore(db)
    await store.reserve(saved)
    await delegationReceipts(db).reserve(receipt.request.requestId, receipt)
    const progress = structuredClone(saved)
    progress.snapshot.revision = crypto.randomUUID()
    progress.snapshot.tasks[1]!.preview = 'Sibling still working'
    await store.save(progress, saved.snapshot.revision)
    db.close(); db = connect()
    expect(await delegationReceipts(db).reserve(receipt.request.requestId, receipt)).toEqual(receipt)
    const changed = structuredClone(receipt)
    changed.request.taskId = saved.snapshot.tasks[1]!.taskId
    await expect(delegationReceipts(db).reserve(receipt.request.requestId, changed)).rejects.toThrow('request conflict')
    expect(await delegationReceipts(db).read(receipt.request.requestId)).toEqual(receipt)
    expect(await delegationStore(db).read(saved.snapshot.delegationId)).toEqual(progress)
})

test('completed Stop acknowledgements remain immutable and replay after reopen', async () => {
    const saved = record(), receipt = intent(saved), receipts = delegationReceipts(db)
    await delegationStore(db).reserve(saved)
    await receipts.reserve(receipt.request.requestId, receipt)
    const done = structuredClone(saved.snapshot)
    done.revision = crypto.randomUUID()
    done.tasks[0]!.status = 'stopped'; done.tasks[0]!.cleanup = 'complete'
    const completed = { ...receipt, delegation: done }
    await receipts.put(receipt.request.requestId, completed)
    await receipts.put(receipt.request.requestId, completed)
    const changed = structuredClone(completed)
    changed.delegation.revision = crypto.randomUUID()
    changed.delegation.tasks[1]!.status = 'done'
    await expect(receipts.put(receipt.request.requestId, changed)).rejects.toThrow('already recorded')
    db.close(); db = connect()
    expect(await delegationReceipts(db).read(receipt.request.requestId)).toEqual(completed)
    expect(await delegationReceipts(db).reserve(receipt.request.requestId, receipt)).toEqual(completed)
})

test('a completion cannot substitute a different owner, task, request or delegation under the same digest', async () => {
    const saved = record(), receipt = intent(saved), receipts = delegationReceipts(db)
    await delegationStore(db).reserve(saved)
    await receipts.reserve(receipt.request.requestId, receipt)
    for (const field of ['owner', 'task', 'request', 'delegation'] as const) {
        const changed: StopReceipt = { ...structuredClone(receipt), delegation: structuredClone(saved.snapshot) }
        if (field === 'owner') changed.source.parentAgentId = 'other-owner'
        if (field === 'task') changed.request.taskId = saved.snapshot.tasks[1]!.taskId
        if (field === 'request') changed.request.requestId = crypto.randomUUID()
        if (field === 'delegation') changed.delegation!.delegationId = crypto.randomUUID()
        await expect(receipts.put(receipt.request.requestId, changed)).rejects.toThrow()
    }
    expect(await receipts.read(receipt.request.requestId)).toEqual(receipt)
})

test('stable task admission survives sibling progress, but a legacy task still requires its displayed revision', async () => {
    const saved = record(), store = delegationStore(db)
    saved.snapshot.tasks[0]!.stopRevision = crypto.randomUUID()
    const receipt = intent(saved)
    receipt.request.expectedRevision = saved.snapshot.tasks[0]!.stopRevision!
    await store.reserve(saved)
    const progress = structuredClone(saved)
    progress.snapshot.revision = crypto.randomUUID()
    progress.snapshot.tasks[1]!.status = 'running'
    progress.snapshot.tasks[1]!.preview = 'New sibling text since the button was rendered'
    await store.save(progress, saved.snapshot.revision)
    expect(await delegationReceipts(db).reserve(receipt.request.requestId, receipt)).toEqual(receipt)
    const wrongToken = { ...receipt, request: { ...receipt.request, requestId: crypto.randomUUID(), expectedRevision: progress.snapshot.revision } }
    await expect(delegationReceipts(db).reserve(wrongToken.request.requestId, wrongToken)).rejects.toThrow('reservation changed')
    const legacy = { ...receipt, request: { ...receipt.request, requestId: crypto.randomUUID(), taskId: saved.snapshot.tasks[1]!.taskId, expectedRevision: saved.snapshot.revision } }
    await expect(delegationReceipts(db).reserve(legacy.request.requestId, legacy)).rejects.toThrow('reservation changed')
    legacy.request.expectedRevision = progress.snapshot.revision
    expect(await delegationReceipts(db).reserve(legacy.request.requestId, legacy)).toEqual(legacy)
    db.close(); db = connect()
    expect(await delegationReceipts(db).read(receipt.request.requestId)).toEqual(receipt)
    expect(await delegationReceipts(db).reserve(receipt.request.requestId, receipt)).toEqual(receipt)
})

test('five streaming tasks can stop the queued and selected active tasks using the original displayed tokens and replay receipts after restart', async () => {
    const { createDelegationRuntime } = await import('../../../../../engine/src/desktop/delegation/runtime')
    type Host = import('../../../../../engine/src/desktop/delegation/types').DelegationHost
    type Event = import('../../../../../engine/src/desktop/delegation/types').ProgressEvent
    const waits = new Map<string, { resolve: (text: string) => void; progress?: (event: Event) => Promise<void> }>()
    const stopped: string[] = []
    const host: Host = {
        current: async () => ({ connectionId: 'connection', model: 'model', tools: [] }), isolatedTool: () => false,
        allocate: async (_source, taskId) => ({ token: taskId, identity: `private-${taskId}` }), recover: async () => null,
        create: async (_resource, input) => {
            let resolve!: (text: string) => void
            const result = new Promise<string>(done => { resolve = done })
            const wait: { resolve: (text: string) => void; progress?: (event: Event) => Promise<void> } = { resolve }
            waits.set(input.task, wait)
            return { settled: Promise.resolve(), stop: async () => { stopped.push(input.task); resolve('late result') }, run: async progress => { wait.progress = progress; return result } }
        },
        drain: async () => {}, admitOutputs: async () => [], cleanup: async () => {}, publicText: (_source, text) => text,
    }
    const source = { parentAgentId: 'owner', parentSessionId: 'parent-chat', parentRunId: 'parent-run', toolCallId: 'delegate-tool' }
    const runtime = createDelegationRuntime(delegationStore(db), host, delegationReceipts(db))
    await runtime.reconcile()
    const parent = new AbortController()
    const executing = runtime.execute(source, { tasks: ['first', 'second', 'third', 'fourth', 'queued'].map(task => ({ task })) }, parent.signal)
    try {
        for (let attempt = 0; attempt < 100 && [...waits.values()].filter(wait => wait.progress).length < 4; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
        expect([...waits.values()].filter(wait => wait.progress)).toHaveLength(4)
        const [displayed] = await runtime.list(source.parentSessionId)
        expect(new Set(displayed!.tasks.map(task => task.stopRevision)).size).toBe(5)
        const queued = displayed!.tasks[4]!, active = displayed!.tasks[0]!
        const request = { operation: 'stop-task' as const, requestId: crypto.randomUUID(), delegationId: displayed!.delegationId, taskId: queued.taskId, expectedRevision: queued.stopRevision! }
        for (let index = 0; index < 3; index++) for (const wait of waits.values()) await wait.progress!({ type: 'text', text: `streaming text ${index}` })
        expect((await runtime.list(source.parentSessionId))[0]!.revision).not.toBe(displayed!.revision)
        await expect(runtime.stop({ ...source, parentSessionId: 'wrong-chat' }, request)).rejects.toThrow('owner mismatch')
        await expect(runtime.stop(source, { ...request, requestId: crypto.randomUUID(), taskId: crypto.randomUUID() })).rejects.toThrow('task unavailable')
        await expect(runtime.stop(source, { ...request, requestId: crypto.randomUUID(), expectedRevision: active.stopRevision! })).rejects.toThrow('revision conflict')
        const queuedResult = await runtime.stop(source, request)
        expect(queuedResult.tasks[4]).toMatchObject({ status: 'stopped', cleanup: 'complete', stopRevision: queued.stopRevision })
        expect(queuedResult.tasks[4]!.startedAt).toBeUndefined()
        expect(queuedResult.tasks.slice(0, 4).every(task => task.status === 'running')).toBe(true)
        expect(stopped).toEqual([])
        expect(waits.has('queued')).toBe(false)
        const activeRequest = { ...request, requestId: crypto.randomUUID(), taskId: active.taskId, expectedRevision: active.stopRevision! }
        await waits.get('second')!.progress!({ type: 'step' })
        const activeResult = await runtime.stop(source, activeRequest)
        expect(activeResult.tasks[0]).toMatchObject({ status: 'stopped', cleanup: 'complete', stopRevision: active.stopRevision })
        expect(stopped).toEqual(['first'])
        expect(activeResult.tasks.slice(1, 4).every(task => task.status === 'running')).toBe(true)
        for (const name of ['second', 'third', 'fourth']) waits.get(name)!.resolve(name)
        const final = await executing
        expect(final.tasks.map(task => task.status)).toEqual(['stopped', 'done', 'done', 'done', 'stopped'])
        db.close(); db = connect()
        const restarted = createDelegationRuntime(delegationStore(db), host, delegationReceipts(db))
        await restarted.reconcile()
        expect(await restarted.stop(source, request)).toEqual(queuedResult)
        expect(await restarted.stop(source, activeRequest)).toEqual(activeResult)
        expect(stopped).toEqual(['first'])
        expect(waits.size).toBe(4)
    } finally {
        parent.abort()
        for (const wait of waits.values()) wait.resolve('fixture finished')
        await executing
    }
})
