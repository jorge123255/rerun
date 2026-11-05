import { describe, expect, it } from 'vitest'
import {
    DESKTOP_COWORKER_CALL_INTERRUPTED_REASON,
    DESKTOP_COWORKER_CALL_MAX_FANOUT,
    DESKTOP_COWORKER_CALL_RESULT_MAX_CHARS,
    desktopCoworkerCallDepthError,
    desktopCoworkerCallFanoutError,
    desktopCoworkerCallResultLimitError,
} from '@rerun/contracts'
import { desktopCoworkerCallee, desktopCoworkerCallFingerprint, desktopCoworkerCallSourceKey, resolveDesktopCoworkerCallTarget } from './prepare.js'
import { createDesktopCoworkerCallRuntime, type DesktopCoworkerCallDeps, type ExecuteCoworkerCall } from './runtime.js'
import { createMemoryCoworkerCallStore, type CoworkerCallRow } from './store.js'
import { desktopCallAgentTools } from './tool.js'

const caller = { publicAgentId: '11111111-1111-4111-8111-111111111111', engineAgentId: 'engine-caller', name: 'Ann' }
const bob = { publicAgentId: '22222222-2222-4222-8222-222222222222', engineAgentId: 'engine-bob', name: 'Bob', enabled: true, callable: true }
const SESSION = '33333333-3333-4333-8333-333333333333'

function streamOf(parts: unknown[]): AsyncIterable<unknown> {
    return (async function* () { for (const part of parts) yield part })()
}

function hanging(): AsyncIterable<unknown> {
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }) }
}

function row(overrides: Partial<CoworkerCallRow> = {}): CoworkerCallRow {
    return {
        callId: crypto.randomUUID(), revision: 1, sourceKey: crypto.randomUUID(), requestFingerprint: desktopCoworkerCallFingerprint(call()), parentAgentId: caller.publicAgentId, parentSessionId: SESSION,
        parentRunId: crypto.randomUUID(), toolCallId: 'seed', targetAgentId: bob.publicAgentId, targetSessionId: null, targetName: bob.name, wait: false,
        status: 'queued', phase: 'reserved', launchEpoch: 'epoch-1', launchClaimed: false, engineParentAgentId: caller.engineAgentId,
        engineParentSessionId: 'engine-parent-session', engineParentRunId: 'engine-parent-run', engineTargetAgentId: bob.engineAgentId,
        engineTargetSessionId: null, engineChildRunId: null, depth: 0, ancestors: [caller.publicAgentId],
        progress: { steps: 0, toolCalls: 0, failures: 0, preview: '', calls: [] }, resultText: null, pendingToolCallId: null, error: null, stopRequestId: null,
        createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z', ...overrides,
    }
}

function harness(overrides: Partial<DesktopCoworkerCallDeps> = {}) {
    let tick = Date.parse('2026-11-05T00:00:00.000Z')
    const store = createMemoryCoworkerCallStore()
    const sessions: { title: string; prompt?: string }[] = []
    const prompts: string[] = []
    const failed: string[] = []
    let stream: AsyncIterable<unknown> = streamOf([{ type: 'text-delta', text: 'done' }])
    let allow = true
    const deps: DesktopCoworkerCallDeps = {
        epoch: 'epoch-1',
        now: () => new Date(tick += 1).toISOString(),
        newCallId: () => crypto.randomUUID(),
        newPublicRunId: () => crypto.randomUUID(),
        store,
        prepareTarget: async input => ({ ...input.target, connectionId: 'connection-bob', model: 'model-bob' }),
        cancelChildRun: async () => undefined,
        authorize: async () => allow
            ? { ok: true, caller: { publicAgentId: caller.publicAgentId, publicSessionId: SESSION, name: caller.name, targets: [bob] } }
            : { ok: false, reason: 'Call coworkers is turned off for this coworker.' },
        createEngineSession: async input => {
            sessions.push({ title: input.title })
            return { engineSessionId: 'engine-child-session' }
        },
        adoptPublicSession: async () => ({ publicSessionId: '44444444-4444-4444-8444-444444444444' }),
        notifyOpened: async () => undefined,
        notifyFailed: async input => { failed.push(input.reason) },
        startChildRun: async input => {
            await input.onRunCreated('engine-child-run')
            await input.assertActive()
            prompts.push(input.prompt)
            return { engineRunId: 'engine-child-run', follow: { runId: 'engine-child-run', settled: Promise.resolve(), result: { fullStream: stream } } }
        },
        ...overrides,
    }
    if (!overrides.store) deps.store = store
    return { runtime: createDesktopCoworkerCallRuntime(deps), store: deps.store === store ? store : store, sessions, prompts, failed, setStream: (next: AsyncIterable<unknown>) => { stream = next }, setAllow: (next: boolean) => { allow = next } }
}

function call(partial: Partial<ExecuteCoworkerCall> = {}): ExecuteCoworkerCall {
    return {
        engineAgentId: caller.engineAgentId, engineSessionId: 'engine-parent-session', engineRunId: 'engine-parent-run', toolCallId: partial.toolCallId ?? 'tool-1',
        callerName: caller.name, agentRef: bob.name, message: 'Hello', wait: true, onProgress: () => undefined, ...partial,
    }
}

describe('desktop coworker call runtime', () => {
    it('reserves the child before opening its session and returns only public snapshot fields', async () => {
        const store = createMemoryCoworkerCallStore()
        let tick = Date.parse('2026-11-05T00:00:00.000Z')
        let reservedBeforeSession = false
        const runtime = createDesktopCoworkerCallRuntime({
            epoch: 'epoch-1', now: () => new Date(tick += 1).toISOString(), newCallId: () => crypto.randomUUID(), newPublicRunId: () => crypto.randomUUID(), store,
            prepareTarget: async input => ({ ...input.target, connectionId: 'connection-bob', model: 'model-bob' }),
            cancelChildRun: async () => undefined,
            authorize: async () => ({ ok: true, caller: { publicAgentId: caller.publicAgentId, publicSessionId: SESSION, name: caller.name, targets: [bob] } }),
            createEngineSession: async () => {
                const saved = await store.getBySource(desktopCoworkerCallSourceKey(call()))
                reservedBeforeSession = saved?.phase === 'reserved' && saved.engineTargetSessionId == null
                return { engineSessionId: 'engine-child-session' }
            },
            adoptPublicSession: async () => ({ publicSessionId: '44444444-4444-4444-8444-444444444444' }),
            notifyOpened: async () => undefined, notifyFailed: async () => undefined,
            startChildRun: async input => {
                await input.onRunCreated('engine-child-run')
                return { engineRunId: 'engine-child-run', follow: { runId: 'engine-child-run', settled: Promise.resolve(), result: { fullStream: streamOf([{ type: 'text-delta', text: 'done' }]) } } }
            },
        })
        const result = await runtime.execute(call())
        expect(reservedBeforeSession).toBe(true)
        expect(Object.keys(result.snapshot ?? {}).sort()).toEqual(['callId', 'createdAt', 'parentAgentId', 'parentRunId', 'parentSessionId', 'progress', 'revision', 'status', 'targetAgentId', 'targetName', 'targetSessionId', 'toolCallId', 'updatedAt', 'wait'])
        expect(JSON.stringify(result.snapshot)).not.toContain('engine-')
        expect(result.snapshot?.status).toBe('completed')
        expect(result.text).toBe('done')
    })

    it('replays one source identity onto the same child', async () => {
        let release: (value: { engineRunId: string; follow: { runId: string; settled: Promise<unknown>; result: { fullStream: AsyncIterable<unknown> } } }) => void = () => undefined
        const started = new Promise<{ engineRunId: string; follow: { runId: string; settled: Promise<unknown>; result: { fullStream: AsyncIterable<unknown> } } }>(resolve => { release = resolve })
        let starts = 0
        const { runtime } = harness({
            startChildRun: async input => {
                starts += 1
                await input.onRunCreated('engine-child-run')
                return started
            },
        })
        const input = call({ wait: false })
        const first = runtime.execute(input)
        const second = runtime.execute(input)
        expect(second).toBe(first)
        release({ engineRunId: 'engine-child-run', follow: { runId: 'engine-child-run', settled: Promise.resolve(), result: { fullStream: streamOf([]) } } })
        await first
        await runtime.execute(input)
        expect(starts).toBe(1)
    })

    it('refuses a switched-off, unallowed, ambiguous, or mentioned target before a session', async () => {
        const store = createMemoryCoworkerCallStore()
        let tick = Date.parse('2026-11-05T00:00:00.000Z')
        let sessions = 0
        const other = { ...bob, publicAgentId: '55555555-5555-4555-8555-555555555555', engineAgentId: 'engine-other-bob' }
        let targets = [bob, other]
        const runtime = createDesktopCoworkerCallRuntime({
            epoch: 'epoch-1', now: () => new Date(tick += 1).toISOString(), newCallId: () => crypto.randomUUID(), newPublicRunId: () => crypto.randomUUID(), store,
            prepareTarget: async input => ({ ...input.target, connectionId: 'connection-bob', model: 'model-bob' }),
            cancelChildRun: async () => undefined,
            authorize: async () => ({ ok: true, caller: { publicAgentId: caller.publicAgentId, publicSessionId: SESSION, name: caller.name, targets } }),
            createEngineSession: async () => { sessions += 1; return { engineSessionId: 'engine-child-session' } },
            adoptPublicSession: async () => ({ publicSessionId: SESSION }), notifyOpened: async () => undefined, notifyFailed: async () => undefined,
            startChildRun: async () => { throw new Error('should not start') },
        })
        const ambiguous = await runtime.execute(call())
        expect(ambiguous.text).toContain(bob.publicAgentId)
        expect(ambiguous.text).toContain(other.publicAgentId)
        expect(ambiguous.text).not.toContain('engine-')
        targets = [{ ...bob, enabled: false, callable: false }]
        expect((await runtime.execute(call({ toolCallId: 'tool-off' }))).text).toBe('Coworker "Bob" is switched off and cannot be called.')
        targets = [{ ...bob, callable: false }]
        expect((await runtime.execute(call({ toolCallId: 'tool-grant' }))).text).toBe('Coworker "Bob" is not allowed for this coworker.')
        targets = [bob]
        expect((await runtime.execute(call({ toolCallId: 'tool-mention', agentRef: '@Bob' }))).text).toContain('was not found')
        expect(sessions).toBe(0)
        expect(store.rows()).toEqual([])
    })

    it('refuses a loop and a call past the named depth before a session', async () => {
        const loopStore = createMemoryCoworkerCallStore()
        let tick = Date.parse('2026-11-05T00:00:00.000Z')
        let sessions = 0
        const build = (store: ReturnType<typeof createMemoryCoworkerCallStore>) => createDesktopCoworkerCallRuntime({
            epoch: 'epoch-1', now: () => new Date(tick += 1).toISOString(), newCallId: () => crypto.randomUUID(), newPublicRunId: () => crypto.randomUUID(), store,
            prepareTarget: async input => ({ ...input.target, connectionId: 'connection-bob', model: 'model-bob' }),
            cancelChildRun: async () => undefined,
            authorize: async () => ({ ok: true, caller: { publicAgentId: caller.publicAgentId, publicSessionId: SESSION, name: caller.name, targets: [bob] } }),
            createEngineSession: async () => { sessions += 1; return { engineSessionId: 'engine-child-session' } },
            adoptPublicSession: async () => ({ publicSessionId: SESSION }), notifyOpened: async () => undefined, notifyFailed: async () => undefined,
            startChildRun: async () => { throw new Error('should not start') },
        })
        await loopStore.insertReserved(row({ engineChildRunId: 'engine-parent-run', ancestors: [bob.publicAgentId], depth: 0, sourceKey: 'inbound-loop' }))
        expect((await build(loopStore).execute(call({ toolCallId: 'tool-loop' }))).text).toBe('Coworker calls cannot loop back to Bob.')
        const deepStore = createMemoryCoworkerCallStore()
        await deepStore.insertReserved(row({ engineChildRunId: 'engine-parent-run', sourceKey: 'inbound-deep', depth: 2, ancestors: ['66666666-6666-4666-8666-666666666666'] }))
        expect((await build(deepStore).execute(call({ toolCallId: 'tool-deep' }))).text).toBe(desktopCoworkerCallDepthError())
        expect(sessions).toBe(0)
    })

    it('names the fanout limit and does not insert the next call', async () => {
        const { runtime, store, sessions } = harness()
        for (let index = 0; index < DESKTOP_COWORKER_CALL_MAX_FANOUT; index += 1) {
            expect((await store.insertReserved(row({ callId: crypto.randomUUID(), sourceKey: `seed-${index}`, toolCallId: `seed-${index}` }))).inserted).toBe(true)
        }
        const result = await runtime.execute(call({ toolCallId: 'tool-fanout', wait: false }))
        expect(result.text).toBe(desktopCoworkerCallFanoutError())
        expect(result.snapshot).toBeNull()
        expect(store.rows()).toHaveLength(DESKTOP_COWORKER_CALL_MAX_FANOUT)
        expect(sessions).toEqual([])
    })

    it('shares one public parent run id', async () => {
        const { runtime } = harness()
        const first = await runtime.execute(call({ toolCallId: 'tool-a', wait: false }))
        const second = await runtime.execute(call({ toolCallId: 'tool-b', wait: false }))
        expect(first.snapshot?.parentRunId).toBe(second.snapshot?.parentRunId)
        expect(first.snapshot?.parentRunId).not.toBe('engine-parent-run')
    })

    it('does not restart a call after its epoch changes', async () => {
        const store = createMemoryCoworkerCallStore()
        const source = call({ toolCallId: 'tool-old' })
        await store.adoptEpoch('epoch-1', '2026-11-05T00:00:00.000Z')
        await store.insertReserved(row({ sourceKey: desktopCoworkerCallSourceKey(source), toolCallId: 'tool-old', status: 'running', phase: 'launched', launchEpoch: 'epoch-1', launchClaimed: true, engineChildRunId: 'engine-old-child' }))
        await store.adoptEpoch('epoch-2', '2026-11-05T00:00:01.000Z')
        expect((await store.getBySource(desktopCoworkerCallSourceKey(source)))?.status).toBe('interrupted')
        let sessions = 0
        let tick = Date.parse('2026-11-05T00:00:02.000Z')
        const runtime = createDesktopCoworkerCallRuntime({
            epoch: 'epoch-2', now: () => new Date(tick += 1).toISOString(), newCallId: () => crypto.randomUUID(), newPublicRunId: () => crypto.randomUUID(), store,
            prepareTarget: async input => ({ ...input.target, connectionId: 'connection-bob', model: 'model-bob' }),
            cancelChildRun: async () => undefined,
            authorize: async () => ({ ok: true, caller: { publicAgentId: caller.publicAgentId, publicSessionId: SESSION, name: caller.name, targets: [bob] } }),
            createEngineSession: async () => { sessions += 1; return { engineSessionId: 'engine-child-session' } },
            adoptPublicSession: async () => ({ publicSessionId: SESSION }), notifyOpened: async () => undefined, notifyFailed: async () => undefined,
            startChildRun: async () => { throw new Error('should not start') },
        })
        const interrupted = await runtime.execute(source)
        expect(interrupted.text).toBe(DESKTOP_COWORKER_CALL_INTERRUPTED_REASON)
        expect(interrupted.snapshot?.status).toBe('interrupted')
        expect(sessions).toBe(0)
    })

    it('cancels a waited child with the calling run and leaves a dispatched child running', async () => {
        const waited = harness()
        waited.setStream(hanging())
        const parent = new AbortController()
        const stopped = await waited.runtime.execute(call({ parentSignal: parent.signal, wait: true, onProgress: snapshot => { if (snapshot.status === 'running') parent.abort() } }))
        expect(stopped.text).toBe('(error calling Bob: (stopped: stopped along with the calling run))')
        expect(stopped.snapshot?.status).toBe('cancelled')

        const dispatched = harness()
        const signal = new AbortController()
        const sent = await dispatched.runtime.execute(call({ parentSignal: signal.signal, wait: false, toolCallId: 'tool-dispatch', onProgress: snapshot => { if (snapshot.status === 'dispatched') signal.abort() } }))
        expect(sent.text).toBe('Message dispatched to Bob. It is handling it in its own session; you will not receive the answer here.')
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(dispatched.store.rows().find(item => item.toolCallId === 'tool-dispatch')?.status).toBe('completed')
    })

    it('redacts secrets, keeps the prompt to context and message, and refuses an over-long answer whole', async () => {
        const { runtime, prompts } = harness()
        await runtime.execute(call({ message: 'token: supersecretvalue', context: 'notes', wait: true }))
        expect(prompts).toEqual(['notes\n\n---\n\ntoken: supersecretvalue'])
        const preview = harness()
        preview.setStream(streamOf([{ type: 'text-delta', text: 'token: supersecretvalue sk-abcdefghij' }]))
        const shown = await preview.runtime.execute(call({ toolCallId: 'tool-secret' }))
        expect(shown.text).not.toContain('supersecretvalue')
        expect(shown.text).not.toContain('sk-abcdefghij')
        expect(shown.snapshot?.progress.preview).not.toContain('supersecretvalue')
        const huge = harness()
        huge.setStream(streamOf([{ type: 'text-delta', text: 'a'.repeat(DESKTOP_COWORKER_CALL_RESULT_MAX_CHARS + 1) }]))
        const refused = await huge.runtime.execute(call({ toolCallId: 'tool-long' }))
        expect(refused.text).toBe(desktopCoworkerCallResultLimitError('Bob'))
        expect(refused.text).not.toContain('aaa')
        expect(refused.snapshot?.status).toBe('error')
        expect(huge.store.rows()[0]?.resultText).toBe(refused.text)
    })

    it('reports an open ask_user as waiting-human without a tool summary', async () => {
        let release = () => undefined
        const gate = new Promise<void>(resolve => { release = resolve })
        const timer = setTimeout(release, 500)
        const waiting = harness()
        waiting.setStream((async function* () {
            yield { type: 'tool-call', toolName: 'ask_user', toolCallId: 'q1', input: { question: 'Pick' } }
            await gate
        })())
        const statuses: string[] = []
        await waiting.runtime.execute(call({
            toolCallId: 'tool-ask',
            onProgress: snapshot => {
                statuses.push(snapshot.status)
                expect(snapshot.progress.calls.every(item => !('summary' in item))).toBe(true)
                if (snapshot.status === 'waiting-human') { clearTimeout(timer); release() }
            },
        }))
        expect(statuses).toContain('waiting-human')
    })

    it('marks a reserved call error when the target changes before launch and does not launch it again', async () => {
        let checks = 0
        let sessions = 0
        const store = createMemoryCoworkerCallStore()
        let tick = Date.parse('2026-11-05T00:00:00.000Z')
        const runtime = createDesktopCoworkerCallRuntime({
            epoch: 'epoch-1', now: () => new Date(tick += 1).toISOString(), newCallId: () => crypto.randomUUID(), newPublicRunId: () => crypto.randomUUID(), store,
            prepareTarget: async input => ({ ...input.target, connectionId: 'connection-bob', model: 'model-bob' }),
            cancelChildRun: async () => undefined,
            authorize: async () => {
                checks += 1
                const callable = checks === 1
                return { ok: true, caller: { publicAgentId: caller.publicAgentId, publicSessionId: SESSION, name: caller.name, targets: [{ ...bob, callable }] } }
            },
            createEngineSession: async () => { sessions += 1; return { engineSessionId: 'engine-child-session' } },
            adoptPublicSession: async () => ({ publicSessionId: SESSION }), notifyOpened: async () => undefined, notifyFailed: async () => undefined,
            startChildRun: async () => { throw new Error('should not start') },
        })
        const failed = await runtime.execute(call())
        expect(failed.text).toContain('Coworker "Bob" is not allowed for this coworker.')
        expect(failed.snapshot?.status).toBe('error')
        expect(sessions).toBe(0)
        await runtime.execute(call())
        expect(sessions).toBe(0)
        expect(store.rows()).toHaveLength(1)
    })

    it('writes the queued marker before any await and refuses a run that has no id', async () => {
        let started = false
        const writes: unknown[] = []
        const tools = desktopCallAgentTools({
            agent: { id: 'engine-caller', config: { name: 'Ann' } }, sessionId: 'engine-parent-session', runId: 'engine-parent-run',
            writer: { write: (part: unknown) => { expect(started).toBe(false); writes.push(part) } },
        } as never, { execute: async () => { started = true; return { text: 'ok', snapshot: null } } })
        const answer = await (tools.call_agent as { execute: (input: unknown, options: unknown) => Promise<string> }).execute(
            { agent: 'Bob', message: 'Hello', wait: false }, { toolCallId: 'tool-1' })
        expect(answer).toBe('ok')
        expect(writes[0]).toMatchObject({ type: 'data-call-agent', id: 'tool-1', data: { agentName: 'Bob', status: 'queued', steps: 0, toolCalls: 0, failures: 0, preview: '', calls: [] } })
        const missing = desktopCallAgentTools({ agent: { id: 'engine-caller', config: { name: 'Ann' } }, sessionId: 's', writer: { write: () => undefined } } as never, {
            execute: async () => { throw new Error('should not run') },
        })
        expect(await (missing.call_agent as { execute: (input: unknown, options: unknown) => Promise<string> }).execute({ agent: 'Bob', message: 'Hello', wait: false }, { toolCallId: 'tool-2' })).toBe('This run can no longer call a coworker.')
    })

    it('turns self-improvement off on a copy and refuses duplicate names', () => {
        const original = { id: 'engine-bob', config: { selfImprovement: { enabled: true }, model: 'kept' } }
        const copy = desktopCoworkerCallee(original)
        expect(original.config.selfImprovement.enabled).toBe(true)
        expect(copy.config.selfImprovement.enabled).toBe(false)
        expect(copy.config.model).toBe('kept')
        const resolved = resolveDesktopCoworkerCallTarget('Bob', [bob, { ...bob, publicAgentId: '55555555-5555-4555-8555-555555555555', engineAgentId: 'engine-second', callable: false }])
        expect('error' in resolved).toBe(true)
    })
})

describe('desktop coworker call launch and recovery boundaries', () => {
    it('requires target setup/model admission before creating a session', async () => {
        const blocked = harness({ prepareTarget: async () => { throw new Error('Complete this coworker setup first') } })
        const result = await blocked.runtime.execute(call())
        expect(result.text).toContain('setup first')
        expect(blocked.sessions).toEqual([])
        expect(blocked.prompts).toEqual([])
        expect(result.snapshot?.status).toBe('error')
    })

    it('refuses a changed target engine identity before creating a session', async () => {
        let checks = 0
        const changed = harness({ authorize: async () => ({ ok: true, caller: {
            publicAgentId: caller.publicAgentId, publicSessionId: SESSION, name: caller.name,
            targets: [{ ...bob, engineAgentId: ++checks === 1 ? bob.engineAgentId : 'replacement-engine' }],
        } }) })
        expect((await changed.runtime.execute(call())).text).toContain('not allowed')
        expect(changed.sessions).toEqual([])
        expect(changed.prompts).toEqual([])
    })

    it('refuses a model change at launch and drains the already reserved exact run', async () => {
        let checks = 0
        const cancelled: string[] = []
        const changed = harness({
            prepareTarget: async input => ({ ...input.target, connectionId: 'connection-bob', model: ++checks === 1 ? 'model-before' : 'model-after' }),
            cancelChildRun: async input => { cancelled.push(input.engineRunId) },
        })
        const result = await changed.runtime.execute(call())
        expect(result.text).toContain('model changed')
        expect(changed.prompts).toEqual([])
        expect(cancelled).toEqual(['engine-child-run'])
        expect(changed.store.rows()[0]).toMatchObject({ engineChildRunId: 'engine-child-run', status: 'error' })
    })

    it('makes child lineage durable before child model work can make a nested call', async () => {
        const store = createMemoryCoworkerCallStore()
        const child = harness({ store, startChildRun: async input => {
            await input.onRunCreated('engine-child-run')
            const lineage = await store.inbound('engine-child-run')
            expect(lineage).toMatchObject({ parentAgentId: caller.publicAgentId, targetAgentId: bob.publicAgentId, depth: 0 })
            expect(input.model).toMatchObject({ connectionId: 'connection-bob', model: 'model-bob' })
            await input.assertActive()
            return { engineRunId: 'engine-child-run', follow: { runId: 'engine-child-run', settled: Promise.resolve(), result: { fullStream: streamOf([]) } } }
        } })
        expect((await child.runtime.execute(call())).snapshot?.status).toBe('completed')
    })

    it('waits for exact child cancellation before reporting a post-launch bookkeeping failure', async () => {
        const store = createMemoryCoworkerCallStore()
        let released!: () => void
        let cancelling!: () => void
        const reached = new Promise<void>(resolve => { cancelling = resolve })
        const drained = new Promise<void>(resolve => { released = resolve })
        const failing = harness({
            store: { ...store, patch: async (...args) => { if (args[2].phase === 'launched') throw new Error('Launch acknowledgement lost'); return store.patch(...args) } },
            cancelChildRun: async input => { expect(input.engineRunId).toBe('engine-child-run'); cancelling(); await drained },
        })
        let finished = false
        const result = failing.runtime.execute(call()).then(value => { finished = true; return value })
        await reached
        expect(finished).toBe(false)
        expect(store.rows()[0].status).toBe('queued')
        released()
        expect((await result).snapshot?.status).toBe('error')
    })

    it('records a minted run even when Stop already owns the call, then cancels it without provider work', async () => {
        const store = createMemoryCoworkerCallStore()
        const cancelled: string[] = []
        const stopped = harness({ store, cancelChildRun: async input => { cancelled.push(input.engineRunId) }, startChildRun: async input => {
            const current = store.rows()[0]
            await store.patch(current.callId, {}, { stopRequestId: crypto.randomUUID() }, current.updatedAt)
            await input.onRunCreated('engine-child-run')
            throw new Error('Provider work must not start')
        } })
        expect((await stopped.runtime.execute(call())).snapshot?.status).toBe('cancelled')
        expect(cancelled).toEqual(['engine-child-run'])
        expect(store.rows()[0]).toMatchObject({ engineChildRunId: 'engine-child-run', status: 'cancelled' })
    })

    it('keeps the actual terminal outcome when Stop owns its token during natural completion', async () => {
        const store = createMemoryCoworkerCallStore()
        const child = harness({ store })
        child.setStream((async function* () {
            yield { type: 'text-delta', text: 'done' }
            const current = store.rows()[0]
            await store.patch(current.callId, {}, { stopRequestId: crypto.randomUUID() }, current.updatedAt)
        })())
        const result = await child.runtime.execute(call())
        expect(result.snapshot?.status).toBe('completed')
        expect(store.rows()[0]).toMatchObject({ status: 'completed', resultText: 'done' })
    })

    it('persists exact pending-human identity after settlement and keeps it across epoch adoption', async () => {
        const store = createMemoryCoworkerCallStore()
        await store.adoptEpoch('epoch-1', '2026-11-05T00:00:00.000Z')
        const child = harness({ store, startChildRun: async input => {
            await input.onRunCreated('engine-child-run')
            return { engineRunId: 'engine-child-run', follow: { runId: 'engine-child-run', settled: Promise.resolve({ kind: 'done', pendingToolCallId: 'human-question-1' }), result: { fullStream: streamOf([{ type: 'text-delta', text: 'Choose a colour' }]) } } }
        } })
        const result = await child.runtime.execute(call())
        expect(result.snapshot?.status).toBe('waiting-human')
        expect(store.rows()[0]).toMatchObject({ status: 'waiting-human', phase: 'terminal', pendingToolCallId: 'human-question-1' })
        expect(JSON.stringify(result.snapshot)).not.toContain('human-question-1')
        await store.adoptEpoch('epoch-2', '2026-11-05T00:00:01.000Z')
        expect(store.rows()[0].status).toBe('waiting-human')
        const restarted = harness({ store, epoch: 'epoch-2' })
        expect((await restarted.runtime.execute(call())).snapshot?.status).toBe('waiting-human')
        expect(restarted.sessions).toEqual([])
        expect(store.rows()[0].pendingToolCallId).toBe('human-question-1')
    })

    it.each(['error', 'cancelled'] as const)('keeps the settled %s outcome even when the stream ended with text', async kind => {
        const child = harness({ startChildRun: async input => {
            await input.onRunCreated('engine-child-run')
            return { engineRunId: 'engine-child-run', follow: { runId: 'engine-child-run', settled: Promise.resolve({ kind, error: 'Persistence failed' }), result: { fullStream: streamOf([{ type: 'text-delta', text: 'Partial answer' }]) } } }
        } })
        const result = await child.runtime.execute(call())
        expect(result.snapshot?.status).toBe(kind)
        expect(result.text).toContain(kind === 'error' ? 'Persistence failed' : 'stopped by the user')
    })

    it('catches progress persistence failures and drains the owned child', async () => {
        const store = createMemoryCoworkerCallStore()
        const cancelled: string[] = []
        const child = harness({
            store: { ...store, patch: async (...args) => { if (args[2].progress && args[2].phase !== 'terminal') throw new Error('Progress store unavailable'); return store.patch(...args) } },
            cancelChildRun: async input => { cancelled.push(input.engineRunId) },
        })
        expect((await child.runtime.execute(call())).snapshot?.status).toBe('error')
        expect(cancelled).toEqual(['engine-child-run'])
    })

    it('does not let a closed caller stream fail the durable child', async () => {
        const child = harness()
        expect((await child.runtime.execute(call({ onProgress: () => { throw new Error('Writer closed') } }))).snapshot?.status).toBe('completed')
    })

    it('refuses changed source payloads during both inflight and durable replay', async () => {
        let release!: () => void
        let opened!: () => void
        const waiting = new Promise<void>(resolve => { release = resolve })
        const reached = new Promise<void>(resolve => { opened = resolve })
        const child = harness({ startChildRun: async input => {
            await input.onRunCreated('engine-child-run'); opened(); await waiting
            return { engineRunId: 'engine-child-run', follow: { runId: 'engine-child-run', settled: Promise.resolve(), result: { fullStream: streamOf([]) } } }
        } })
        const first = child.runtime.execute(call())
        await reached
        expect((await child.runtime.execute(call({ message: 'Changed' }))).text).toContain('different request')
        release()
        await first
        expect((await child.runtime.execute(call({ wait: false }))).text).toContain('different request')
        expect(child.sessions).toHaveLength(1)
    })

    it('refuses a different request on a raced source-key insert without revealing the existing row', async () => {
        const store = createMemoryCoworkerCallStore()
        const existing = row({ sourceKey: 'same-source', requestFingerprint: desktopCoworkerCallFingerprint(call()) })
        await store.insertReserved(existing)
        await expect(store.insertReserved({ ...existing, requestFingerprint: desktopCoworkerCallFingerprint(call({ context: 'different context' })) })).rejects.toThrow('request changed')
        expect(store.rows()).toEqual([existing])
    })
})
