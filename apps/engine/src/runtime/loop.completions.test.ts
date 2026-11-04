import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-loop-completions-'))
process.env.RERUN_DESKTOP_APP = '1'
process.env.RERUN_LOG_LEVEL = 'fatal'

const completion = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined, fail: false, calls: 0 }))
vi.mock('../db/completed-runs.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../db/completed-runs.js')>()
    return {
        ...actual,
        recordRunCompletion: async (input: Parameters<typeof actual.recordRunCompletion>[0]) => {
            completion.calls++
            await completion.gate
            if (completion.fail) throw new Error('fixture completion disk failure')
            await actual.recordRunCompletion(input)
        },
    }
})
vi.mock('./notify.js', async importOriginal => ({
    ...(await importOriginal<typeof import('./notify.js')>()),
    sendNotification: async () => ({ delivered: false }),
}))
vi.mock('../tools/registry.js', () => ({ buildTools: async () => ({ tools: {}, close: async () => {} }) }))
vi.mock('../agents/providers.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../agents/providers.js')>()
    const { MockLanguageModelV3 } = await import('ai/test')
    return {
        ...actual,
        resolveModel: () => ({
            model: new MockLanguageModelV3({
                doStream: async () => ({
                    stream: new ReadableStream({
                        start(controller) {
                            for (const part of [
                                { type: 'stream-start', warnings: [] },
                                { type: 'text-start', id: 'answer' },
                                { type: 'text-delta', id: 'answer', delta: 'The saved answer is 42.' },
                                { type: 'text-end', id: 'answer' },
                                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {
                                    inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
                                    outputTokens: { total: 2, text: 2, reasoning: 0 },
                                } },
                            ]) controller.enqueue(part)
                            controller.close()
                        },
                    }),
                }),
            }),
            close: async () => {},
        }),
    }
})

const { afterEach, beforeAll, expect, it } = await import('vitest')
const { mkdir } = await import('node:fs/promises')
const { migrate } = await import('../db/migrate.js')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { agentDir } = await import('../config/paths.js')
const { getAgent } = await import('../agents/registry.js')
const { createSession } = await import('../db/repos/sessions.js')
const { getRun, startRun } = await import('../db/repos/runs.js')
const { listMessages } = await import('../db/repos/messages.js')
const { listRunCompletions } = await import('../db/completed-runs.js')
const { logger } = await import('../lib/logger.js')
const { runAgent } = await import('./loop.js')
const { claimSession, releaseSession, sessionClaim } = await import('./run-control.js')
const id = 'completion-loop-owner'

beforeAll(async () => {
    await migrate()
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, agentConfigSchema.parse({ name: id, selfImprovement: { enabled: false }, tools: { memory: false } }))
})
afterEach(() => { completion.gate = undefined; completion.fail = false; completion.calls = 0; vi.restoreAllMocks() })

async function start(sessionId: string) {
    const agent = await getAgent(id)
    const row = await startRun(id, sessionId)
    // The HTTP admission path claims the conversation before invoking runAgent. Reproduce that
    // real boundary, rather than observing a null claim in a directly started unclaimed run.
    expect(claimSession(sessionId, row.id)).toBeNull()
    return runAgent({ ...agent, resolved: { ...agent.resolved, provider: 'openai', model: 'fixture' } }, sessionId, 'What is the answer?', undefined, undefined, row.id)
}

it('holds run.settled and the admitted session claim until the actual completion record is durable', async () => {
    const session = await createSession(id, 'Deferred completion')
    let release!: () => void
    completion.gate = new Promise<void>(resolve => { release = resolve })
    const run = await start(session.id)
    let settled = false
    void run.settled.then(() => { settled = true })
    try {
        await vi.waitFor(() => expect(completion.calls).toBe(1))
        // The answer and done run row already exist; they alone must not permit the next send.
        expect((await getRun(id, run.runId))?.status).toBe('done')
        expect(JSON.stringify(await listMessages(id, session.id))).toContain('The saved answer is 42.')
        expect(settled).toBe(false)
        expect(sessionClaim(session.id)?.runId).toBe(run.runId)
        expect(claimSession(session.id, 'too-early')).toBe(run.runId)
        expect((await listRunCompletions(id, { limit: 100 })).some(row => row.runId === run.runId)).toBe(false)
    } finally { release(); await run.settled }
    expect(await run.settled).toMatchObject({ kind: 'done' })
    expect(sessionClaim(session.id)).toBeNull()
    expect((await listRunCompletions(id, { limit: 100 })).filter(row => row.runId === run.runId)).toMatchObject([{ text: 'The saved answer is 42.', sessionId: session.id }])
    expect(claimSession(session.id, 'after-durable-write')).toBeNull()
    releaseSession('after-durable-write')
})

it('logs failed completion persistence, resolves settlement and admits a succeeding turn without deadlock', async () => {
    const session = await createSession(id, 'Failed completion')
    completion.fail = true
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const run = await start(session.id)
    expect(await run.settled).toMatchObject({ kind: 'done' })
    expect(completion.calls).toBe(1)
    expect(sessionClaim(session.id)).toBeNull()
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ agent: id, run: run.runId, err: expect.stringContaining('fixture completion disk failure') }), 'run completion event could not be persisted or delivered')
    expect((await listRunCompletions(id, { limit: 100 })).some(row => row.runId === run.runId)).toBe(false)
    completion.fail = false
    const next = await start(session.id)
    expect(await next.settled).toMatchObject({ kind: 'done' })
    expect(completion.calls).toBe(2)
    expect(sessionClaim(session.id)).toBeNull()
    expect((await listRunCompletions(id, { limit: 100 })).some(row => row.runId === next.runId)).toBe(true)
})
