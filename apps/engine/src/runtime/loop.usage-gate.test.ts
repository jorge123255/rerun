import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-usage-gate-'))

const admission = vi.hoisted(() => ({ frozen: false, providers: 0 }))
vi.mock('../desktop/workspace-admission.js', () => ({ assertDesktopRunAdmission: () => { if (admission.frozen) throw new Error('Workspace switching'); return 0 } }))

// Captured instead of sent: the assertions are about what the hub is told, which is the only thing
// that moves a conversation off "working".
const { sent, stream, partial, proposal } = vi.hoisted(() => ({
    sent: [] as Array<Record<string, unknown>>,
    stream: { parts: [] as unknown[], hang: false },
    partial: { push: false },
    proposal: { push: false },
}))

vi.mock('../desktop/policy.js', async importOriginal => ({ ...await importOriginal<typeof import('../desktop/policy.js')>(), desktopApp: () => true, assertDesktopProvider: () => {} }))

vi.mock('./notify.js', async importOriginal => {
    const actual = await importOriginal<typeof import('./notify.js')>()
    return {
        ...actual,
        sendNotification: async (input: Record<string, unknown>) => {
            sent.push(input)
            return { delivered: true }
        },
    }
})

vi.mock('../tools/registry.js', () => ({
    buildTools: async (ctx: { partialResults?: { label: string; text: string }[]; skillProposals?: { proposalId: string; mode: string; title: string }[] }) => {
        if (partial.push) ctx.partialResults?.push({ label: 'Task 1 — competitors', text: 'four brands found' })
        if (proposal.push) ctx.skillProposals?.push({ proposalId: 'proposal-1', mode: 'create', title: 'Publishing checklist' })
        return { tools: {}, close: async () => {} }
    },
}))

vi.mock('../agents/providers.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../agents/providers.js')>()
    const { MockLanguageModelV3 } = await import('ai/test')
    return {
        ...actual,
        resolveModel: () => { admission.providers++; return ({
            model: new MockLanguageModelV3({
                doStream: async () => ({
                    stream: new ReadableStream({
                        start(controller) {
                            for (const part of stream.parts) controller.enqueue(part)
                            // A provider that wedges never closes its stream: no finish part, no
                            // error part, no callback of any kind.
                            if (!stream.hang) controller.close()
                        },
                    }),
                }),
            }),
            close: async () => {},
        }) },
    }
})

const { afterEach, beforeAll, describe, expect, it } = await import('vitest')
const { mkdir } = await import('node:fs/promises')
const { migrate } = await import('../db/migrate.js')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { agentDir } = await import('../config/paths.js')
const { getAgent } = await import('../agents/registry.js')
const { createSession } = await import('../db/repos/sessions.js')
const { getRun } = await import('../db/repos/runs.js')
const { listMessages } = await import('../db/repos/messages.js')
const { STREAM_CUT_RAW_REASON } = await import('./provider-errors.js')
const { runAgent } = await import('./loop.js')
const { abortRun, claimSession, sessionClaim } = await import('./run-control.js')

const gate = await import('../desktop/usage-gate.js')
const { ROUTINE_FAILURES_BEFORE_OFF } = await import('@rerun/contracts')
const { readDesktopRoutineHealth, settleDesktopRoutineRun } = await import('../desktop/routine-runs.js')

const id = 'usagegateagent'

const textTurn = (finishReason: { unified: string; raw?: string }): unknown[] => [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: 'partial answer' },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
]

const target = { connectionId: 'mac-chatgpt', plan: 'ChatGPT', provider: 'codex' }

async function scheduled(usageGate?: typeof target, routine?: { parts: string[]; test: boolean }) {
    const session = await createSession(id, 'schedule: daily', undefined, 'schedule')
    const agent = await getAgent(id)
    const run = await runAgent(agent, session.id, 'do the daily work', undefined, undefined, undefined, { source: 'schedule', slug: 'daily', name: 'Daily', ...(usageGate && { usageGate }), ...(routine && { routine }) })
    return { run, sessionId: session.id, outcome: await run.settled }
}

describe('a routine run the plan refused for usage', () => {
    beforeAll(async () => {
        await migrate()
        await mkdir(agentDir(id), { recursive: true })
        await writeAgentConfig(id, agentConfigSchema.parse({ name: 'usage gate' }))
        await gate.initializeUsageGate(id)
    })

    afterEach(async () => { sent.length = 0; stream.parts = []; await gate.clearUsageWait(id, 'daily') })

    it('is stopped and parked, not stored or announced as a failure', async () => {
        stream.parts = textTurn({ unified: 'length', raw: 'usage_limit_exceeded' })

        const { outcome, run, sessionId } = await scheduled(target)

        expect(outcome).toEqual({ kind: 'cancelled' })
        // Not `error`: nothing that counts failed runs of a routine sees this one.
        expect((await getRun(id, run.runId))?.status).toBe('cancelled')
        expect(sent.some(note => note.kind === 'error')).toBe(false)
        expect(sent.find(note => note.event === 'agent.schedule.completed')).toMatchObject({ kind: 'done', metadata: expect.objectContaining({ status: 'cancelled' }) })
        expect(await gate.readUsageWait(id, 'daily')).toMatchObject({ plan: 'ChatGPT', state: 'waiting', tryBackup: true })
        const said = (await listMessages(id, sessionId)).map(row => JSON.stringify(row)).join(' ')
        expect(said).toContain('Waiting for ChatGPT to have usage again')
    })

    it('does not count toward the ten failures that switch a routine off, and is not a quiet run', async () => {
        // One real failure short of auto-off.
        for (let index = 0; index < ROUTINE_FAILURES_BEFORE_OFF - 1; index += 1) {
            await settleDesktopRoutineRun({ agentId: id, runId: `failed-${index}`, slug: 'daily', name: 'Daily', kind: 'error', routine: { parts: [], test: false } })
        }
        const before = async () => (await readDesktopRoutineHealth(id, [{ slug: 'daily', enabled: true }])).get('daily')!
        expect(await before()).toMatchObject({ consecutiveFailures: ROUTINE_FAILURES_BEFORE_OFF - 1, autoDisabledAt: null })
        stream.parts = textTurn({ unified: 'length', raw: 'usage_limit_exceeded' })

        const { outcome } = await scheduled(target, { parts: ['Read the inbox'], test: false })

        expect(outcome).toEqual({ kind: 'cancelled' })
        // Neither counted nor cleared: the count is exactly where the real failures left it.
        expect(await before()).toEqual({ consecutiveFailures: ROUTINE_FAILURES_BEFORE_OFF - 1, autoDisabledAt: null, lastOutcome: null })
        const told = sent.find(note => note.event === 'agent.schedule.completed') as { metadata: Record<string, unknown> }
        expect(told.metadata).not.toHaveProperty('quiet')
        expect(told.metadata).not.toHaveProperty('routineAutoDisabled')
        expect(await gate.readUsageWait(id, 'daily')).toMatchObject({ state: 'waiting' })
    })

    it('still fails a run that was started by hand', async () => {
        stream.parts = textTurn({ unified: 'length', raw: 'usage_limit_exceeded' })

        const { outcome, run } = await scheduled()

        expect(outcome).toMatchObject({ kind: 'error', errorCode: 'provider_usage_limit' })
        expect((await getRun(id, run.runId))?.status).toBe('error')
        expect(await gate.readUsageWait(id, 'daily')).toBeNull()
    })
})
