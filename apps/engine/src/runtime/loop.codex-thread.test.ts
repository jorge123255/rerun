import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-codex-thread-'))

const { calls, prompts, turn, lifecycle, improvement, retry } = vi.hoisted(() => ({
    retry: { hooks: undefined as undefined | { canRetry: () => boolean; notify: (notice: unknown) => void }, during: [] as boolean[], reconnects: false },
    calls: [] as Array<Record<string, unknown> | undefined>,
    prompts: [] as unknown[],
    turn: { threadId: 'thread-1', fail: false, closeHangs: false, closeFails: false },
    lifecycle: [] as string[],
    improvement: [] as boolean[],
}))

vi.mock('./notify.js', async importOriginal => ({ ...(await importOriginal<typeof import('./notify.js')>()), sendNotification: async () => ({ delivered: true }) }))
vi.mock('../tools/registry.js', () => ({ buildTools: async (ctx: {agent:{config:{selfImprovement:{enabled:boolean}}}}) => { improvement.push(ctx.agent.config.selfImprovement.enabled); return { tools: {}, close: async () => {} } } }))
vi.mock('../connections/cli-auth.js', () => ({ ensureCliAuth: async () => () => {} }))
vi.mock('../connections/codex-auth.js', () => ({ syncCodexAuth: async () => {} }))
vi.mock('../connections/codex-plan-limits.js', () => ({ refreshCodexPlanLimits: async () => {} }))
vi.mock('../desktop/native-worker.js',()=>({createDesktopNativeWorker:async()=>({
    cwd:'/fixture/scratch',url:'ws://127.0.0.1:1/fixture',
    finish:async()=>{lifecycle.push('worker-finish');throw new Error('review acknowledgement lost')},
    close:async()=>{lifecycle.push('worker-close')},
})}))
// The real curator spawns the Codex CLI after each turn and logs once the file is torn down.
vi.mock('./curator.js', () => ({ runCurator: async () => {} }))
vi.mock('../agents/availability.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../agents/availability.js')>()),
    resolveRunModel: async () => ({
        provider: 'codex', model: 'gpt-5.5',
        connection: { id: 'mac-chatgpt', env: {}, config: { codexReasoning: { 'gpt-5.5': { supported: ['low', 'medium', 'high'], default: 'medium' } } } },
    }),
}))

vi.mock('../agents/providers.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../agents/providers.js')>()
    const { MockLanguageModelV3 } = await import('ai/test')
    return {
        ...actual,
        resolveModel: (...args: unknown[]) => ({
            model: new MockLanguageModelV3({
                doStream: async (options: { prompt: unknown; providerOptions?: Record<string, Record<string, unknown>> }) => {
                    retry.hooks = args[10] as typeof retry.hooks
                    if (retry.reconnects) {
                        retry.during.push(retry.hooks!.canRetry())
                        retry.hooks!.notify({ status: 'reconnecting', attempt: 1, of: 3 })
                    }
                    calls.push(options.providerOptions?.['codex-app-server'])
                    prompts.push(options.prompt)
                    if (turn.fail) throw new Error('codex crashed')
                    return {
                        stream: new ReadableStream({
                            start(controller) {
                                controller.enqueue({ type: 'stream-start', warnings: [] })
                                controller.enqueue({ type: 'text-start', id: '0' })
                                controller.enqueue({ type: 'text-delta', id: '0', delta: 'ok' })
                                controller.enqueue({ type: 'text-end', id: '0' })
                                controller.enqueue({
                                    type: 'finish',
                                    finishReason: { unified: 'stop', raw: 'completed' },
                                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                                    providerMetadata: { 'codex-app-server': { threadId: turn.threadId } },
                                })
                                controller.close()
                            },
                        }),
                    }
                },
            }),
            close: () => { lifecycle.push('model-close'); return turn.closeHangs ? new Promise<void>(() => {}) : turn.closeFails ? Promise.reject(new Error('app-server close failed')) : Promise.resolve() },
        }),
    }
})

const { afterEach, beforeAll, beforeEach, describe, expect, it } = await import('vitest')
const { mkdir } = await import('node:fs/promises')
const { migrate } = await import('../db/migrate.js')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { agentDir } = await import('../config/paths.js')
const { getAgent } = await import('../agents/registry.js')
const { createSession } = await import('../db/repos/sessions.js')
const { appendMessage, listMessages } = await import('../db/repos/messages.js')
const { forkReply } = await import('../db/repos/regenerations.js')
const { getSystemDb } = await import('../db/systemDb.js')
const { forgetCodexThreadsOf } = await import('../agents/codex-threads.js')
const { clearBoxDefault, writeBoxDefault } = await import('../connections/default.js')
const { runAgent } = await import('./loop.js')

const id = 'codexthreadagent'

async function send(sessionId: string, message: string) {
    const run = await runAgent(await getAgent(id), sessionId, message)
    return run.settled
}

describe('a Codex conversation keeps its thread', () => {
    beforeAll(async () => {
        await migrate()
        await mkdir(agentDir(id), { recursive: true })
        await writeAgentConfig(id, agentConfigSchema.parse({ name: 'codex thread' }))
    })

    beforeEach(() => {
        calls.length = 0
        prompts.length = 0
        lifecycle.length = 0
        improvement.length = 0
        turn.threadId = 'thread-1'
        turn.fail = false
        turn.closeHangs = false
        turn.closeFails = false
        forgetCodexThreadsOf('mac-chatgpt')
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('starts a thread on the first message and resumes it on the next', async () => {
        const session = await createSession(id, 'hello')
        await send(session.id, 'hello')
        await send(session.id, 'and then?')
        expect(calls).toEqual([undefined, { threadId: 'thread-1' }])
    })

    it('applies the desktop effort to each turn of an existing conversation', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        vi.stubEnv('RERUN_DESKTOP_CODEX_RUNNER', '/test/codex')
        const selected = { connectionId: 'mac-chatgpt', model: 'gpt-5.5' }
        try {
            const session = await createSession(id, 'effort')
            await writeBoxDefault({ ...selected, reasoningEffort: 'low' })
            await send(session.id, 'first')
            await writeBoxDefault({ ...selected, reasoningEffort: 'high' })
            await send(session.id, 'change effort')
            await writeBoxDefault(selected)
            await send(session.id, 'use the model default')
            await writeBoxDefault({ ...selected, model: 'another-model', reasoningEffort: 'high' })
            await send(session.id, 'keep this model’s own effort')
            expect(calls).toEqual([
                { effort: 'low' },
                { threadId: 'thread-1', effort: 'high' },
                { threadId: 'thread-1', effort: 'medium' },
                { threadId: 'thread-1', effort: 'medium' },
            ])
        } finally {
            vi.unstubAllEnvs()
            await clearBoxDefault()
        }
    })

    it('starts a new thread once a message the thread never saw lands in the session', async () => {
        const session = await createSession(id, 'hello')
        await send(session.id, 'hello')
        await appendMessage(id, session.id, { role: 'assistant', content: 'an answer from another provider' })
        await send(session.id, 'and then?')
        expect(calls).toEqual([undefined, undefined])
    })

    it('regenerates from the exact original user turn without later text or a resumed Codex thread', async () => {
        const { contextTextPart, workspaceAttachmentPart } = await import('@rerun/contracts')
        const source = await createSession(id, 'branch test')
        const earlier = await appendMessage(id, source.id, { role: 'user', content: 'earlier question' })
        await appendMessage(id, source.id, { role: 'assistant', content: 'earlier response' })
        // Older desktop transcripts can contain a {text} envelope for a saved message.
        const { client } = await getSystemDb(id)
        await client.execute({ sql: 'UPDATE messages SET content_json = ? WHERE id = ?', args: ['{"text":"earlier question"}', earlier.id] })
        const content = [
            { type: 'text' as const, text: 'Which draft?' },
            workspaceAttachmentPart({ path: 'draft.md', content: 'ORIGINAL FILE' }),
            contextTextPart('ORIGINAL TURN CONTEXT'),
        ]
        await appendMessage(id, source.id, { role: 'user', content })
        const target = await appendMessage(id, source.id, { role: 'assistant', content: 'DO NOT REPLAY OLD ANSWER' })
        await appendMessage(id, source.id, { role: 'user', content: 'DO NOT REPLAY LATER USER' })
        const old = await listMessages(id, source.id)
        const fork = await forkReply(id, source, { sessionId: source.id, regenerateMessageId: target.id, requestId: crypto.randomUUID() })
        const result = await runAgent(await getAgent(id), fork.sessionId, 'Which draft?', undefined, undefined, fork.runId, { source: 'chat', savedUser: fork.user! })
        expect(await result.settled).toMatchObject({ kind: 'done' })
        expect(calls).toEqual([undefined])
        const prompt = JSON.stringify(prompts[0])
        for (const phrase of ['earlier question', 'earlier response', 'Which draft?', 'ORIGINAL FILE', 'ORIGINAL TURN CONTEXT']) {
            expect(prompt.split(phrase)).toHaveLength(2)
        }
        expect(prompt).not.toContain('DO NOT REPLAY')
        expect(await listMessages(id, source.id)).toEqual(old)
        const alternate = await listMessages(id, fork.sessionId)
        expect(alternate.map(row => row.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
        expect(alternate[2].contentJson).toBe(JSON.stringify(content))
    })

    it('starts a new thread after a turn that failed', async () => {
        const session = await createSession(id, 'hello')
        await send(session.id, 'hello')
        turn.fail = true
        await send(session.id, 'this one breaks')
        turn.fail = false
        await send(session.id, 'again')
        expect(calls).toEqual([undefined, { threadId: 'thread-1' }, undefined])
    })

    it('retains the completed reply when native review persistence fails after the model stops',async()=>{
        vi.stubEnv('RERUN_DESKTOP_APP','1')
        vi.stubEnv('RERUN_DESKTOP_CODEX_RUNNER','/test/codex')
        const original=(await getAgent(id)).config
        try{
            await writeAgentConfig(id,agentConfigSchema.parse({...original,tools:{...original.tools,desktopCodexGrants:{workspaceRead:true,workspaceWrite:true},desktopToolGrants:{nativeWriteback:true}}}))
            const session=await createSession(id,'native review')
            expect(await send(session.id,'make the change')).toMatchObject({kind:'error',error:expect.stringContaining('review acknowledgement lost')})
            expect(lifecycle.slice(0,2)).toEqual(['model-close','worker-finish'])
            const saved=await listMessages(id,session.id)
            expect(saved.some(row=>row.role==='assistant'&&row.contentJson.includes('ok'))).toBe(true)
        }finally{await writeAgentConfig(id,original);vi.unstubAllEnvs()}
    })

    it('keeps a called coworker run from regaining self-improvement during Codex config refresh', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        vi.stubEnv('RERUN_DESKTOP_CODEX_RUNNER', '/test/codex')
        const original = (await getAgent(id)).config
        try {
            await writeAgentConfig(id, agentConfigSchema.parse({ ...original, selfImprovement: { ...original.selfImprovement, enabled: true } }))
            const loaded = await getAgent(id)
            const { desktopCoworkerCallee } = await import('../desktop/coworker-calls/prepare.js')
            const session = await createSession(id, 'called coworker')
            const run = await runAgent(desktopCoworkerCallee(loaded), session.id, 'hello')
            expect(await run.settled).toMatchObject({ kind: 'done' })
            expect(improvement).toEqual([false])
            expect((await getAgent(id)).config.selfImprovement.enabled).toBe(true)
        } finally { await writeAgentConfig(id, original); vi.unstubAllEnvs() }
    })

    it('keeps each session on its own thread', async () => {
        const first = await createSession(id, 'one')
        const second = await createSession(id, 'two')
        await send(first.id, 'one')
        turn.threadId = 'thread-2'
        await send(second.id, 'two')
        await send(first.id, 'one again')
        expect(calls).toEqual([undefined, undefined, { threadId: 'thread-1' }])
    })
    // An app-server that did not go down in time still holds the thread's writer lock: resuming it
    // would be refused with "already has an active writer" (upstream #253, RER-128).
    async function teardownTimesOut(sessionId: string) {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        turn.closeHangs = true
        let settled = false
        void send(sessionId, 'hello').then(() => (settled = true))
        for (let tick = 0; tick < 300 && !settled; tick++) {
            await new Promise(resolve => setImmediate(resolve))
            await vi.advanceTimersByTimeAsync(100)
        }
        expect(settled).toBe(true)
        vi.useRealTimers()
        turn.closeHangs = false
    }

    it('starts a new thread after a turn whose teardown timed out', async () => {
        const session = await createSession(id, 'hello')
        await teardownTimesOut(session.id)
        await send(session.id, 'and then?')
        expect(calls).toEqual([undefined, undefined])
    })

    // What the model's retry middleware is handed: a veto that closes with the run, and a status
    // that reaches the Mac conversation as one live part carrying no error text.
    it('lets a step be retried only while the run is open and shows the reconnect in the Mac conversation', async () => {
        const written: Array<Record<string, unknown>> = []
        const writer = { write: (part: Record<string, unknown>) => { written.push(part) } } as never
        retry.reconnects = true
        try {
            const session = await createSession(id, 'hello')
            await (await runAgent(await getAgent(id), session.id, 'web run', undefined, writer)).settled
            expect(written).toEqual([])
            vi.stubEnv('RERUN_DESKTOP_APP', '1')
            vi.stubEnv('RERUN_DESKTOP_CODEX_RUNNER', '/test/codex')
            const run = await runAgent(await getAgent(id), session.id, 'mac run', undefined, writer)
            await run.settled
            expect(written.filter(part => part.type === 'data-stream-retry')).toEqual([
                { type: 'data-stream-retry', id: `stream-retry-${run.runId}`, data: { status: 'reconnecting', attempt: 1, of: 3, provider: 'Codex' } },
            ])
            expect(retry.during).toEqual([true, true])
            // Settled: nothing is sent again and nothing more is shown.
            expect(retry.hooks!.canRetry()).toBe(false)
            retry.hooks!.notify({ status: 'resumed' })
            expect(written.filter(part => part.type === 'data-stream-retry')).toHaveLength(1)
        } finally {
            retry.reconnects = false
            retry.during.length = 0
            vi.unstubAllEnvs()
        }
    })

    // A close that rejects leaves the app-server possibly up, holding the thread's writer lock.
    it('starts a new thread after a turn whose teardown failed', async () => {
        const session = await createSession(id, 'hello')
        await send(session.id, 'hello')
        await send(session.id, 'resumed')
        expect(calls).toEqual([undefined, { threadId: 'thread-1' }])
        turn.closeFails = true
        await send(session.id, 'its close rejects')
        turn.closeFails = false
        await send(session.id, 'and then?')
        expect(calls.slice(2)).toEqual([{ threadId: 'thread-1' }, undefined])
    })

    // The Mac's coworkers run on the same loop with the desktop runner.
    it('starts a new thread after a timed-out teardown on the Mac runner too', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        vi.stubEnv('RERUN_DESKTOP_CODEX_RUNNER', '/test/codex')
        try {
            const session = await createSession(id, 'hello mac')
            await send(session.id, 'first')
            await send(session.id, 'second')
            expect(calls.at(-1)).toMatchObject({ threadId: 'thread-1' })
            calls.length = 0
            await teardownTimesOut(session.id)
            await send(session.id, 'and then?')
            expect(calls).toHaveLength(2)
            expect(calls[0]).toMatchObject({ threadId: 'thread-1' })
            expect(calls[1]?.threadId).toBeUndefined()
        } finally { vi.unstubAllEnvs() }
    })
})
