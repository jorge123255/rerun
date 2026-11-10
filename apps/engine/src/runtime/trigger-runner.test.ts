import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-trigger-runner-'))
process.env.RERUN_API_KEY = ''
process.env.RERUN_LOG_LEVEL = 'fatal'

type Outcome = { kind: 'done' | 'error' | 'cancelled'; error?: string }

const state = vi.hoisted(() => ({
    agents: {} as Record<string, { id: string; config: { enabled: boolean } }>,
    provider: 'rerun' as string,
    sent: [] as Array<Record<string, unknown>>,
    sessions: [] as Array<{ agentId: string; title: string; source: string }>,
    runs: [] as Array<{ agentId: string; sessionId: string; message: string; override: unknown; trigger: unknown; runId: string; finish: (o: Outcome) => void }>,
    markFired: vi.fn(async (_agentId: string, _slug: string, _at: string) => {}),
}))

vi.mock('../agents/availability.js', () => ({
    automationModel: async () => ({ provider: state.provider, model: 'm' }),
}))
vi.mock('../agents/registry.js', () => ({
    getAgent: async (id: string) => state.agents[id],
}))
vi.mock('../db/repos/sessions.js', () => ({
    createSession: async (agentId: string, title: string, _origin: unknown, source: string) => {
        state.sessions.push({ agentId, title, source })
        return { id: `sess-${state.sessions.length}` }
    },
}))
vi.mock('../triggers/loader.js', () => ({ markFired: state.markFired }))
vi.mock('./notify.js', () => ({
    sendNotification: async (input: Record<string, unknown>) => {
        state.sent.push(input)
        return { delivered: true }
    },
}))
vi.mock('./headless-run.js', () => ({
    startHeadlessRun: async (agent: { id: string }, sessionId: string, message: string, override: unknown, trigger: unknown) => {
        let finish!: (o: Outcome) => void
        const settled = new Promise<Outcome>(r => (finish = r))
        const runId = `run-${state.runs.length + 1}`
        state.runs.push({ agentId: agent.id, sessionId, message, override, trigger, runId, finish })
        return { runId, settled }
    },
}))

const { afterEach, beforeEach, describe, expect, it } = await import('vitest')
const { fireTrigger } = await import('./trigger-runner.js')
const { armBudgetLatch, clearBudgetLatch } = await import('./budget-latch.js')
const { logger } = await import('../lib/logger.js')
type Trigger = import('../triggers/loader.js').Trigger

const hook: Trigger = { slug: 'inbound', name: 'Inbound mail', description: '', enabled: true, token: 't', methods: ['POST'], lastFiredAt: null, fireCount: 0, connectionId: null, provider: null, model: null, body: '', createdAt: '2026-01-01T00:00:00.000Z' }

const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
    state.agents = { on: { id: 'on', config: { enabled: true } }, off: { id: 'off', config: { enabled: false } } }
    state.provider = 'rerun'
})

afterEach(() => {
    state.runs = []
    state.sent = []
    state.sessions = []
    state.markFired.mockReset()
    clearBudgetLatch()
    vi.restoreAllMocks()
})

describe('fireTrigger', () => {
    it('refuses a switched-off agent with a 403', async () => {
        await expect(fireTrigger('off', hook, 'hi')).rejects.toMatchObject({ status: 403 })
        expect(state.runs).toHaveLength(0)
    })

    it('refuses a managed-model run while the budget latch is armed', async () => {
        armBudgetLatch()

        await expect(fireTrigger('on', hook, 'hi')).rejects.toMatchObject({ status: 402 })
        expect(state.sessions).toHaveLength(0)
        expect(state.markFired).not.toHaveBeenCalled()
    })

    it('still fires an agent on its own key while the latch is armed', async () => {
        armBudgetLatch()
        state.provider = 'anthropic'

        await fireTrigger('on', hook, 'hi')

        expect(state.runs).toHaveLength(1)
    })

    it('opens a trigger session, announces it and runs the given message', async () => {
        const started = await fireTrigger('on', hook, 'payload: {"id":1}')

        expect(state.sessions).toEqual([{ agentId: 'on', title: 'trigger: inbound', source: 'trigger' }])
        expect(state.sent).toEqual([
            { event: 'agent.session.created', kind: 'info', agentId: 'on', sessionId: started.sessionId, runId: null, message: 'Triggered run: Inbound mail', title: 'Inbound mail', source: 'trigger' },
        ])
        expect(state.markFired).toHaveBeenCalledWith('on', 'inbound', expect.any(String))
        expect(state.runs[0]).toMatchObject({ sessionId: started.sessionId, message: 'payload: {"id":1}', override: { provider: 'rerun', model: 'm' }, trigger: { source: 'trigger', slug: 'inbound', name: 'Inbound mail' } })
        expect(state.runs[0].trigger).not.toHaveProperty('calledBy')
        expect(started.runId).toBe(state.runs[0].runId)
    })

    it('starts one run per call, even while the previous one is still going', async () => {
        const first = await fireTrigger('on', hook, 'one')
        const second = await fireTrigger('on', hook, 'two')

        expect(first.runId).not.toBe(second.runId)
        expect(first.sessionId).not.toBe(second.sessionId)
        expect(state.runs.map(r => r.message)).toEqual(['one', 'two'])
    })

    it('runs anyway when stamping the trigger fails', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
        state.markFired.mockRejectedValueOnce(new Error('disk full'))

        await fireTrigger('on', hook, 'hi')
        await flush()

        expect(state.runs).toHaveLength(1)
        expect(warn).toHaveBeenCalledWith({ agent: 'on', trigger: 'inbound', err: 'Error: disk full' }, 'markFired failed')
    })

    it('logs a run that ends in error', async () => {
        const errors = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never)
        await fireTrigger('on', hook, 'hi')

        state.runs[0].finish({ kind: 'error', error: 'model refused' })
        await flush()

        expect(errors).toHaveBeenCalledWith({ agent: 'on', trigger: 'inbound', err: 'model refused' }, 'triggered run failed')
    })
})
