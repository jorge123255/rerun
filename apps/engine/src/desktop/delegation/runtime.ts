import { createHash, randomUUID } from 'node:crypto'
import type { DesktopDelegationInput, DesktopDelegationStop } from '@rerun/contracts'
import type { Authority, Child, DelegationHost, DelegationStore, Record, Source, ReceiptStore } from './types.js'

export const DELEGATION_LIMITS = {
    workers: 4,
    tasks: 32,
    title: 200,
    prompt: 32_000,
    result: 64_000,
    preview: 600,
    recentCalls: 8,
    lifetimeMs: 15 * 60_000,
    hostMs: 30_000,
} as const

const prohibited = /^(?:delegate_tasks|call_agent|ask_user|request_approval|request_secret|suggest_service|install_complete|setup_|routine_|trigger_|schedule_|install_|publish_|hub_|notify_|shell_|native_|computer_|browser_|mcp_|service_|takeover_)/i
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sourceKey = (source: Source) => JSON.stringify([source.parentAgentId, source.parentSessionId, source.parentRunId, source.toolCallId])

export function subset(parent: Authority, host: Pick<DelegationHost, 'isolatedTool'>): string[] {
    return [...new Set(parent.tools)].filter(name => !prohibited.test(name) && host.isolatedTool(name))
}

function bounded<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number = DELEGATION_LIMITS.hostMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Host operation timed out')), timeoutMs)
        timer.unref?.()
        const onAbort = () => finish(new Error('Operation cancelled'))
        const finish = (error?: Error) => {
            clearTimeout(timer)
            signal.removeEventListener('abort', onAbort)
            if (error) reject(error)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        work.then(value => {
            clearTimeout(timer)
            signal.removeEventListener('abort', onAbort)
            resolve(value)
        }, error => {
            clearTimeout(timer)
            signal.removeEventListener('abort', onAbort)
            reject(error)
        })
        if (signal.aborted) finish(new Error('Operation cancelled'))
    })
}

function sameAuthority(before: Authority, current: Authority): boolean {
    return before.connectionId === current.connectionId && before.model === current.model
}

export function createDelegationRuntime(store: DelegationStore, host: DelegationHost, receipts: ReceiptStore) {
    const live = new Map<string, { controller: AbortController; child?: Child; done: Promise<void> }>()
    const cleaning = new Map<string, Promise<void>>()
    const pendingStops = new Map<string, { digest: string; promise: Promise<import('./types.js').DesktopDelegationSnapshot> }>()
    const shutdown = new AbortController()
    let activeInvocation: { source: string; digest: string; promise: Promise<import('./types.js').DesktopDelegationSnapshot> } | null = null
    let reconciled = false
    let reconciling: Promise<void> | null = null
    let tail: Promise<unknown> = Promise.resolve()

    const locked = <T,>(fn: () => Promise<T>): Promise<T> => {
        const next = tail.then(fn)
        tail = next.catch(() => {})
        return next
    }

    async function mutate(id: string, edit: (record: Record) => void) {
        return locked(async () => {
            const record = await store.read(id)
            if (!record) throw new Error('Delegation unavailable')
            const revision = record.snapshot.revision
            edit(record)
            record.snapshot.revision = randomUUID()
            await store.save(record, revision)
            return record
        })
    }

    function publicText(source: Source, text: string): string {
        return host.publicText(source, text).slice(0, DELEGATION_LIMITS.result)
    }

    function preservePartial(record: Record, index: number) {
        const task = record.snapshot.tasks[index]!
        if (task.status !== 'done' && task.preview) {
            task.result = publicText(record.snapshot, task.preview)
            task.partial = true
        }
    }

    function settle(record: Record, index: number, status: 'done' | 'error' | 'stopped', message?: string, result?: string) {
        const task = record.snapshot.tasks[index]!
        if (task.status !== 'queued' && task.status !== 'running') {
            if (status !== 'done') preservePartial(record, index)
            return
        }
        task.status = status
        task.finishedAt = Date.now()
        if (status === 'done') {
            task.result = publicText(record.snapshot, result ?? '')
            task.preview = task.result.slice(-DELEGATION_LIMITS.preview)
            task.partial = false
            task.error = undefined
        } else {
            task.error = message
            preservePartial(record, index)
        }
    }

    async function stopQueued(id: string, message: string) {
        await mutate(id, record => {
            for (let index = 0; index < record.snapshot.tasks.length; index++) {
                if (record.snapshot.tasks[index]!.status === 'queued') settle(record, index, 'stopped', message)
            }
        })
    }

    async function clean(id: string, index: number) {
        const key = `${id}:${index}`
        const existing = cleaning.get(key)
        if (existing) return existing
        const work = (async () => {
            try {
                const record = await store.read(id)
                if (!record) return
                const task = record.snapshot.tasks[index]!
                if (task.cleanup === 'complete') return
                const resource = record.resources[index] ?? await host.recover(record.snapshot, task.taskId)
                if (resource) {
                    const signal = AbortSignal.timeout(DELEGATION_LIMITS.hostMs)
                    await bounded(host.drain(resource, signal), signal)
                    if (record.outputs[index] === null) {
                        const outputs = await bounded(host.admitOutputs(resource, record.snapshot, task.taskId, signal), signal)
                        await mutate(id, current => {
                            if (current.outputs[index] === null) current.outputs[index] = outputs
                        })
                    }
                    const current = await store.read(id)
                    const outputs = current?.outputs[index] ?? []
                    await bounded(host.cleanup(resource, outputs, signal), signal)
                }
                await mutate(id, current => {
                    if (current.snapshot.tasks[index]!.cleanup !== 'complete') current.snapshot.tasks[index]!.cleanup = 'complete'
                })
            } catch {
                await mutate(id, current => { current.snapshot.tasks[index]!.cleanup = 'blocked' })
            }
        })()
        cleaning.set(key, work)
        try { await work } finally { cleaning.delete(key) }
    }

    async function execute(source: Source, input: DesktopDelegationInput, parent: AbortSignal) {
        parent.throwIfAborted()
        const authority = await bounded(host.current(source, parent), parent)
        if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > DELEGATION_LIMITS.tasks || input.tasks.some(task =>
            !task || typeof task.task !== 'string' || !task.task.trim() || task.task.length + (task.context?.length ?? 0) > DELEGATION_LIMITS.prompt
            || (task.title !== undefined && (typeof task.title !== 'string' || task.title.length > DELEGATION_LIMITS.title))
            || (task.context !== undefined && typeof task.context !== 'string'))) {
            throw new Error('Delegation input exceeds limits')
        }
        const digest = hash(input)
        const reservation = await store.reserve({
            version: 1,
            digest,
            resources: input.tasks.map(() => null),
            outputs: input.tasks.map(() => null),
            snapshot: {
                ...source,
                delegationId: randomUUID(),
                revision: randomUUID(),
                tasks: input.tasks.map(task => ({
                    taskId: randomUUID(),
                    stopRevision: randomUUID(),
                    title: task.title ?? task.task.slice(0, 60),
                    status: 'queued',
                    steps: 0,
                    toolCalls: 0,
                    failures: 0,
                    preview: '',
                    calls: [],
                    cleanup: 'pending',
                })),
            },
        })
        if (reservation.record.digest !== digest) throw new Error('Invocation identity conflict')
        if (!reservation.created) return reservation.record.snapshot
        const id = reservation.record.snapshot.delegationId
        let next = 0

        const worker = async () => {
            while (next < input.tasks.length) {
                const index = next++
                if (parent.aborted) {
                    await stopQueued(id, 'stopped along with the calling run')
                    continue
                }
                const before = await store.read(id)
                if (!before || before.snapshot.tasks[index]!.status !== 'queued') continue
                const taskId = before.snapshot.tasks[index]!.taskId
                const controller = new AbortController()
                const signal = AbortSignal.any([parent, controller.signal, AbortSignal.timeout(DELEGATION_LIMITS.lifetimeMs)])
                let finish!: () => void
                const done = new Promise<void>(resolve => { finish = resolve })
                live.set(taskId, { controller, done })
                let child: Child | undefined
                let stopWork: Promise<void> | undefined
                const stopChild = () => {
                    if (child) stopWork ??= child.stop()
                    void stopWork?.catch(() => {})
                }
                signal.addEventListener('abort', stopChild, { once: true })
                try {
                    signal.throwIfAborted()
                    const current = await bounded(host.current(source, signal), signal)
                    if (!sameAuthority(authority, current)) throw new Error('Parent model changed')
                    const tools = subset(current, host).filter(tool => authority.tools.includes(tool))
                    const resource = await bounded(host.allocate(source, taskId), signal, DELEGATION_LIMITS.lifetimeMs)
                    await mutate(id, record => {
                        if (record.snapshot.tasks[index]!.status !== 'queued') throw new Error('Task admission stopped')
                        record.resources[index] = resource
                    })
                    signal.throwIfAborted()
                    const authorizeTool = async (tool: string) => {
                        signal.throwIfAborted()
                        const now = await bounded(host.current(source, signal), signal)
                        if (!sameAuthority(authority, now) || !tools.includes(tool) || !subset(now, host).includes(tool)) throw new Error('Child tool unavailable')
                    }
                    child = await bounded(host.create(resource, { task: input.tasks[index]!.task, context: input.tasks[index]!.context, connectionId: authority.connectionId, model: authority.model, tools, authorizeTool, signal }), signal, DELEGATION_LIMITS.lifetimeMs)
                    live.get(taskId)!.child = child
                    if (signal.aborted) {
                        stopChild()
                        signal.throwIfAborted()
                    }
                    await mutate(id, record => {
                        if (record.snapshot.tasks[index]!.status !== 'queued') throw new Error('Task admission stopped')
                        record.snapshot.tasks[index]!.status = 'running'
                        record.snapshot.tasks[index]!.startedAt = Date.now()
                    })
                    const result = await bounded(child.run(async event => {
                        signal.throwIfAborted()
                        await mutate(id, record => {
                            const task = record.snapshot.tasks[index]!
                            if (task.status !== 'running') return
                            if (event.type === 'step') task.steps++
                            if (event.type === 'text') task.preview = publicText(source, event.text).slice(-DELEGATION_LIMITS.preview)
                            if (event.type === 'call') {
                                if (!tools.includes(event.tool)) throw new Error('Unexpected child tool')
                                task.toolCalls++
                                if (event.failed) task.failures++
                                task.calls.push({ tool: event.tool, summary: '', failed: event.failed })
                                task.calls = task.calls.slice(-DELEGATION_LIMITS.recentCalls)
                            }
                        })
                    }), signal, DELEGATION_LIMITS.lifetimeMs)
                    await bounded(child.settled, signal)
                    signal.throwIfAborted()
                    await bounded(host.current(source, signal), signal)
                    if (Buffer.byteLength(result) > DELEGATION_LIMITS.result) throw new Error('Delegation result exceeds limit')
                    await mutate(id, record => settle(record, index, 'done', undefined, result))
                } catch {
                    stopChild()
                    if (stopWork) {
                        const drainSignal = AbortSignal.timeout(DELEGATION_LIMITS.hostMs)
                        await bounded(Promise.all([stopWork, child?.settled ?? Promise.resolve()]).then(() => undefined), drainSignal).catch(() => {})
                    }
                    await mutate(id, record => settle(record, index, signal.aborted ? 'stopped' : 'error', signal.aborted ? 'stopped along with the calling run or by the user' : 'Sub-coworker failed'))
                } finally {
                    signal.removeEventListener('abort', stopChild)
                    try { await clean(id, index) } finally {
                        live.delete(taskId)
                        finish()
                    }
                }
            }
        }

        await Promise.all(Array.from({ length: Math.min(DELEGATION_LIMITS.workers, input.tasks.length) }, worker))
        if (parent.aborted) await stopQueued(id, 'stopped along with the calling run')
        return (await store.read(id))!.snapshot
    }

    async function stop(source: Pick<Source, 'parentAgentId' | 'parentSessionId'>, request: DesktopDelegationStop) {
        const owner = { parentAgentId: source.parentAgentId, parentSessionId: source.parentSessionId }
        const digest = hash([owner, request.requestId, request.delegationId, request.taskId, request.expectedRevision])
        const pending = pendingStops.get(request.requestId)
        if (pending) {
            if (pending.digest !== digest) throw new Error('Stop identity conflict')
            return pending.promise
        }
        const promise = (async () => {
            const record = await store.read(request.delegationId)
            if (!record || record.snapshot.parentAgentId !== source.parentAgentId || record.snapshot.parentSessionId !== source.parentSessionId) throw new Error('Delegation owner mismatch')
            const prior = await receipts.read(request.requestId)
            if (prior && prior.digest !== digest) throw new Error('Stop identity conflict')
            const index = record.snapshot.tasks.findIndex(task => task.taskId === request.taskId)
            if (index < 0) throw new Error('Delegation task unavailable')
            if (prior?.delegation) return prior.delegation
            const intent = prior ?? await locked(async () => {
                const current = await store.read(request.delegationId)
                const task = current?.snapshot.tasks.find(task => task.taskId === request.taskId)
                if (!current || !task || sourceKey(current.snapshot) !== sourceKey(record.snapshot) || (task.stopRevision ?? current.snapshot.revision) !== request.expectedRevision) throw new Error('Delegation revision conflict')
                return receipts.reserve(request.requestId, { digest, source: owner, request })
            })
            if (intent.digest !== digest) throw new Error('Stop identity conflict')
            // A reserved intent remains valid after a lost acknowledgement, progress update,
            // or restart. Its immutable task identity can never redirect to a sibling run.
            await mutate(request.delegationId, current => {
                const task = current.snapshot.tasks[index]!
                if (task.taskId !== request.taskId) throw new Error('Delegation task changed')
                if (task.status === 'queued' || task.status === 'running') settle(current, index, 'stopped', 'stopped by the user')
            })
            const active = live.get(request.taskId)
            if (active) {
                active.controller.abort()
                await bounded(active.done, AbortSignal.timeout(DELEGATION_LIMITS.hostMs * 2), DELEGATION_LIMITS.hostMs * 2)
            }
            await clean(request.delegationId, index)
            const delegation = (await store.read(request.delegationId))!.snapshot
            if (delegation.tasks[index]!.cleanup !== 'complete') throw new Error('Owned cleanup is not confirmed; retry Stop')
            await receipts.put(request.requestId, { digest, source: owner, request, delegation })
            return delegation
        })()
        pendingStops.set(request.requestId, { digest, promise })
        try { return await promise } finally { pendingStops.delete(request.requestId) }
    }

    return {
        async execute(source: Source, input: DesktopDelegationInput, signal: AbortSignal) {
            const key = sourceKey(source)
            const digest = hash(input)
            if (activeInvocation) {
                if (activeInvocation.source === key) {
                    if (activeInvocation.digest !== digest) throw new Error('Invocation identity conflict')
                    return activeInvocation.promise
                }
                throw new Error('Delegation admission unavailable; one delegation at a time')
            }
            if (!reconciled || shutdown.signal.aborted) throw new Error('Delegation admission unavailable')
            const promise = execute(source, input, AbortSignal.any([signal, shutdown.signal]))
            activeInvocation = { source: key, digest, promise }
            try { return await promise } finally {
                if (activeInvocation?.promise === promise) activeInvocation = null
            }
        },
        async list(sessionId: string) {
            return (await store.list(sessionId)).map(record => record.snapshot)
        },
        stop,
        async shutdown() {
            reconciled = false
            shutdown.abort()
            const active = activeInvocation?.promise
            if (active) await active.catch(() => {})
        },
        async reconcile() {
            if (activeInvocation || live.size) throw new Error('Reconcile only before admission')
            if (reconciling) return reconciling
            reconciling = (async () => {
                for (const record of await store.list()) {
                    const id = record.snapshot.delegationId
                    await mutate(id, current => {
                        for (let index = 0; index < current.snapshot.tasks.length; index++) {
                            const status = current.snapshot.tasks[index]!.status
                            if (status === 'running' || status === 'queued') settle(current, index, 'error', 'Interrupted by restart; task was not replayed')
                        }
                    })
                    for (let index = 0; index < record.snapshot.tasks.length; index++) {
                        if (record.snapshot.tasks[index]!.cleanup !== 'complete') await clean(id, index)
                    }
                }
                reconciled = true
            })()
            try { await reconciling } finally { reconciling = null }
        },
    }
}

export type DelegationRuntime = ReturnType<typeof createDelegationRuntime>

export function orderedDelegationResult(snapshot: import('./types.js').DesktopDelegationSnapshot): string {
    return snapshot.tasks.map((task, index) => {
        const outcome = task.status === 'done'
            ? task.result || '(the sub-coworker returned no text)'
            : `(${task.status}: ${task.error ?? 'not completed'})${task.result ? `\n\nPartial output:\n${task.result}` : ''}`
        return `## Task ${index + 1} — ${task.title}\n${outcome}`
    }).join('\n\n')
}
