import { createHash, randomUUID } from 'node:crypto'
import type { DesktopDelegationInput, DesktopDelegationStop } from '../../../../../packages/contracts/src/desktop-delegation.js'
import type { Authority, Child, DelegationHost, DelegationStore, Record, Source, ReceiptStore } from './types.js'
export const DELEGATION_LIMITS = { workers: 4, tasks: 32, prompt: 32_000, result: 64_000, lifetimeMs: 15 * 60_000 } as const
const denied = /(?:delegate|call_agent|ask|approval|secret|setup|routine|trigger|schedule|install|publish|hub|notify|shell|native|computer|browser|mcp|service)/i
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function subset(parent: Authority, host: Pick<DelegationHost, 'isolatedTool'>): string[] {
    return [...new Set(parent.tools)].filter(name => !denied.test(name) && host.isolatedTool(name))
}
export function createDelegationRuntime(store: DelegationStore, host: DelegationHost, receipts: ReceiptStore) {
    const live = new Map<string, { controller: AbortController; child?: Child; done: Promise<void> }>()
    const shutdownSignal = new AbortController()
    let executing = false
    let reconciled = false
    let tail: Promise<unknown> = Promise.resolve()
    const locked = <T>(fn: () => Promise<T>): Promise<T> => {
        const next = tail.then(fn); tail = next.catch(() => {}); return next
    }
    async function mutate(id: string, edit: (record: Record) => void) {
        return locked(async () => {
            const record = await store.read(id); if (!record) throw new Error('Delegation unavailable')
            const revision = record.snapshot.revision; edit(record); record.snapshot.revision = randomUUID()
            await store.save(record, revision); return record
        })
    }
    async function clean(id: string, index: number) {
        const record = await store.read(id); if (!record) throw new Error('Delegation unavailable')
        const task = record.snapshot.tasks[index]!
        try {
            const resource = record.resources[index] ?? await host.recover(record.snapshot, task.taskId)
            if (resource) { await host.drain(resource); await host.cleanup(resource) }
            await mutate(id, r => { r.snapshot.tasks[index]!.cleanup = 'complete' })
        } catch {
            await mutate(id, r => { r.snapshot.tasks[index]!.cleanup = 'blocked' })
        }
    }
    async function execute(source: Source, input: DesktopDelegationInput, parent: AbortSignal) {
        parent.throwIfAborted()
        const authority = await host.current(source, parent)
        if (!input.tasks.length || input.tasks.length > DELEGATION_LIMITS.tasks || input.tasks.some(t =>
            typeof t.task !== 'string' || !t.task.trim() || t.task.length + (t.context?.length ?? 0) > DELEGATION_LIMITS.prompt || (t.title?.length ?? 0) > 200)) throw new Error('Delegation input exceeds limits')
        const digest = hash(input), delegationId = randomUUID()
        const reservation = await store.reserve({ version: 1, digest, resources: input.tasks.map(() => null), snapshot: {
            ...source, delegationId, revision: randomUUID(), tasks: input.tasks.map(t => ({ taskId: randomUUID(), title: t.title ?? t.task.slice(0, 60),
                status: 'queued', steps: 0, toolCalls: 0, failures: 0, preview: '', calls: [], cleanup: 'pending' })),
        } })
        if (reservation.record.digest !== digest) throw new Error('Invocation identity conflict')
        if (!reservation.created) return reservation.record.snapshot
        const id = reservation.record.snapshot.delegationId
        let next = 0
        const worker = async () => {
            while (next < input.tasks.length) {
                const index = next++, taskId = reservation.record.snapshot.tasks[index]!.taskId
                const before = await store.read(id)
                if (before!.snapshot.tasks[index]!.status !== 'queued') continue
                const controller = new AbortController(), signal = AbortSignal.any([parent, controller.signal, AbortSignal.timeout(DELEGATION_LIMITS.lifetimeMs)])
                let finish!: () => void
                const done = new Promise<void>(resolve => { finish = resolve })
                live.set(taskId, { controller, done })
                let child: Child | undefined
                let stopWork: Promise<void> | undefined
                const stop = () => { if (child) stopWork ??= child.stop(); void stopWork?.catch(() => {}) }
                signal.addEventListener('abort', stop, { once: true })
                try {
                    signal.throwIfAborted()
                    if ((await store.read(id))!.snapshot.tasks[index]!.status !== 'queued') continue
                    const current = await host.current(source, signal)
                    if (current.model !== authority.model) throw new Error('Model changed')
                    const tools = subset(current, host).filter(t => authority.tools.includes(t))
                    const resource = await host.allocate(source, taskId)
                    // Allocation uses the reserved task ID so crash reconciliation can find a pre-save allocation.
                    await mutate(id, r => { r.resources[index] = resource })
                    signal.throwIfAborted()
                    const authorizeTool = async (tool: string) => {
                        signal.throwIfAborted()
                        const now = await host.current(source, signal)
                        if (now.model !== authority.model || !tools.includes(tool) || !subset(now, host).includes(tool)) throw new Error('Child tool unavailable')
                    }
                    child = await host.create(resource, { ...input.tasks[index]!, model: authority.model, tools, authorizeTool, signal })
                    live.get(taskId)!.child = child
                    if (signal.aborted) { stop(); signal.throwIfAborted() }
                    await mutate(id, r => { const t = r.snapshot.tasks[index]!; t.status = 'running'; t.startedAt = Date.now() })
                    const result = await child.run(async event => {
                        signal.throwIfAborted()
                        await mutate(id, r => {
                            const task = r.snapshot.tasks[index]!
                            if (event.type === 'step') task.steps++
                            if (event.type === 'text') task.preview = host.publicText(source, event.text).slice(-600)
                            if (event.type === 'call') {
                                if (!tools.includes(event.tool)) throw new Error('Unexpected child tool')
                                task.toolCalls++; task.failures = event.failed ? task.failures + 1 : 0
                                task.calls.push({ tool: event.tool, summary: '', failed: event.failed }); task.calls = task.calls.slice(-8)
                            }
                        })
                    })
                    await child.settled
                    signal.throwIfAborted(); await host.current(source, signal)
                    if (Buffer.byteLength(result) > DELEGATION_LIMITS.result) throw new Error('Delegation result exceeds limit')
                    await mutate(id, r => { const t = r.snapshot.tasks[index]!; t.status = 'done'; t.result = host.publicText(source, result); t.preview = t.result.slice(-600); t.finishedAt = Date.now() })
                } catch {
                    if (child) { stop(); try { await stopWork; await child.settled } catch { /* drain below remains authoritative */ } }
                    await mutate(id, r => { const t = r.snapshot.tasks[index]!; t.status = signal.aborted ? 'stopped' : 'error'; t.error = signal.aborted ? 'stopped along with the calling run or by the user' : 'Sub-coworker failed'; t.finishedAt = Date.now() })
                } finally {
                    signal.removeEventListener('abort', stop)
                    try { await clean(id, index) } finally { live.delete(taskId); finish() }
                }
            }
        }
        await Promise.all(Array.from({ length: Math.min(DELEGATION_LIMITS.workers, input.tasks.length) }, worker))
        return (await store.read(id))!.snapshot
    }
    return { async execute(source: Source, input: DesktopDelegationInput, signal: AbortSignal) {
            if (!reconciled || executing || shutdownSignal.signal.aborted) throw new Error('Delegation admission unavailable; one delegation at a time')
            executing = true
            try { return await execute(source, input, AbortSignal.any([signal, shutdownSignal.signal])) } finally { executing = false }
        },
        async list(sessionId: string) { return (await store.list(sessionId)).map(r => r.snapshot) },
        async stop(source: Pick<Source, 'parentAgentId' | 'parentSessionId'>, request: DesktopDelegationStop) {
            const digest = hash([source, request])
            const prior = await receipts.read(request.requestId)
            if (prior) { if (prior.digest !== digest) throw new Error('Stop identity conflict'); return prior.delegation }
            const record = await store.read(request.delegationId)
            if (!record || record.snapshot.parentAgentId !== source.parentAgentId || record.snapshot.parentSessionId !== source.parentSessionId) throw new Error('Delegation owner mismatch')
            const index = record.snapshot.tasks.findIndex(t => t.taskId === request.taskId)
            if (index < 0 || record.snapshot.revision !== request.expectedRevision) throw new Error('Delegation revision conflict')
            await mutate(request.delegationId, r => {
                if (r.snapshot.revision !== request.expectedRevision) throw new Error('Delegation revision conflict')
                const t = r.snapshot.tasks[index]!
                if (t.status === 'queued' || t.status === 'running') { t.status = 'stopped'; t.finishedAt = Date.now() }
            })
            const active = live.get(request.taskId)
            if (active) { active.controller.abort(); await active.done }
            await clean(request.delegationId, index)
            const delegation = (await store.read(request.delegationId))!.snapshot
            if (delegation.tasks[index]!.cleanup !== 'complete') throw new Error('Owned cleanup is not confirmed; retry Stop')
            await receipts.put(request.requestId, { digest, delegation }); return delegation
        },
        async shutdown() {
            reconciled = false
            shutdownSignal.abort()
            const tasks = [...live.values()]
            for (const task of tasks) task.controller.abort()
            await Promise.all(tasks.map(task => task.done))
        },
        async reconcile() {
            if (live.size || executing) throw new Error('Reconcile only before admission')
            for (const record of await store.list()) {
                const id = record.snapshot.delegationId
                await mutate(id, r => { for (const t of r.snapshot.tasks) if (t.status === 'running' || t.status === 'queued') { t.status = 'error'; t.error = 'Interrupted by restart; task was not replayed'; t.finishedAt = Date.now() } })
                for (let i = 0; i < record.snapshot.tasks.length; i++) if (record.snapshot.tasks[i]!.cleanup !== 'complete') await clean(id, i)
            }
            reconciled = true
        },
    }
}
export type DelegationRuntime = ReturnType<typeof createDelegationRuntime>
export function orderedDelegationResult(snapshot: import('./types.js').DesktopDelegationSnapshot): string {
    return snapshot.tasks.map((t, i) => `## Task ${i + 1} — ${t.title}\n${t.result || (t.status === 'done' ? '(the sub-coworker returned no text)' : `(${t.status}: ${t.error ?? 'not completed'})`)}`).join('\n\n')
}
