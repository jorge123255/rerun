import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ConnectionSummary } from '@rerun/contracts'
import type { DesktopRuntime } from './runtime'

const state = vi.hoisted(() => ({ db: null as unknown, connections: [] as unknown[], pick: { connectionId: 'mac-chatgpt', model: 'gpt-6-sol' }, sessions: new Set(['s1']) }))
vi.mock('server-only', () => ({}))
vi.mock('./database', () => ({ openDesktopDatabase: async () => state.db }))
vi.mock('./settings', () => ({ readDesktopProviders: async () => ({ connections: state.connections }) }))
vi.mock('./store', () => ({
    findDesktopAgent: async (_db: unknown, id: string) => id === 'a1' ? { id: 'a1', engineAgentId: 'engine-a1' } : null,
    findDesktopSession: async (_db: unknown, id: string) => state.sessions.has(id) ? { id, agentId: 'a1' } : null,
}))
// The conversation's model, passed through the real gate: its own plan, the backup, or a refusal.
vi.mock('./chat-model', async () => {
    const gate = await import('./usage-gate-model')
    return {
        resolveDesktopChatModel: async (runtime: DesktopRuntime) => {
            const found = gate.gateDesktopPick(state.connections as ConnectionSummary[], state.pick, await gate.readDesktopBackupModel(runtime))
            return { connectionId: found.connectionId, model: found.model, source: 'conversation', ...(found.note && { presetNote: found.note, viaBackup: true }) }
        },
    }
})
import { initializeDesktopRound68 } from './round68-schema'
import { saveDesktopBackupModel } from './usage-gate-model'
import { cancelDesktopUsageWait, flushDesktopUsageWaits, queueDesktopUsageWait, readDesktopUsageWait, type DesktopUsageWaitSend } from './usage-waits'

const runtime = { dataRoot: '/usage-waits' } as DesktopRuntime
const START = new Date('2026-11-16T10:00:00.000Z'), RESET = '2026-11-16T15:00:00.000Z', AFTER = new Date('2026-11-16T15:01:00.000Z')
const base = { connected: true, credentialRejected: false, extraModels: [], planLimits: null }
const chatgpt = (usedPercent: number, resetsAt: string | null = RESET) => ({ ...base, id: 'mac-chatgpt', name: 'ChatGPT', provider: 'codex', models: ['gpt-6-sol'],
    planLimits: { capturedAt: START.toISOString(), windows: [{ kind: 'session', label: null, usedPercent, resetsAt }] } })
const claude = { ...base, id: 'mac-claude', name: 'Claude', provider: 'claude', models: ['claude-opus-5-5'] }
const key = { ...base, id: 'openai-key', name: 'OpenAI', provider: 'openai', models: ['gpt-paid'] }
let db: Client
const sent: Array<Record<string, unknown>> = []
const send: DesktopUsageWaitSend = async (_runtime, input) => { sent.push(input); return { response: new Response('stream') } }
const message = { agentId: 'a1', sessionId: 's1', text: 'Summarise the week' }

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(START)
    // A file, not memory: the migration runs in a transaction, which opens its own connection.
    db = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), 'rerun-usage-waits-')), 'desktop.db')}` }); state.db = db
    await db.execute('CREATE TABLE desktop_schema_migrations (version INTEGER PRIMARY KEY, id TEXT NOT NULL)')
    await initializeDesktopRound68(db)
    state.connections = [chatgpt(100), claude, key]; state.pick = { connectionId: 'mac-chatgpt', model: 'gpt-6-sol' }; state.sessions = new Set(['s1']); sent.length = 0
})
afterEach(() => { vi.useRealTimers(); db.close() })

test('tells the conversation which plan it is waiting for and when it resets', async () => {
    expect(await readDesktopUsageWait(runtime, 'a1', 's1')).toEqual({ wait: null, plan: { name: 'ChatGPT', resetsAt: RESET }, backupSet: false })
})

test('queues exactly that message once, and sends it once when the plan resets', async () => {
    const queued = await queueDesktopUsageWait(runtime, message)
    expect(queued.wait).toMatchObject({ text: 'Summarise the week', plan: 'ChatGPT', resetsAt: RESET, state: 'waiting' })
    // A second click, or a second window, cannot queue it twice.
    await expect(queueDesktopUsageWait(runtime, message)).rejects.toThrow('already waiting')

    expect(await flushDesktopUsageWaits(runtime, send, new Date('2026-11-16T14:59:00.000Z'))).toEqual([])
    expect(sent).toHaveLength(0)

    vi.setSystemTime(AFTER); state.connections = [chatgpt(2, '2026-11-16T20:00:00.000Z'), claude, key]
    expect(await flushDesktopUsageWaits(runtime, send, AFTER)).toEqual([queued.wait!.id])
    expect(sent).toEqual([{ agentId: 'a1', sessionId: 's1', requestId: queued.wait!.id, text: 'Summarise the week' }])

    // Later ticks find nothing left to send.
    expect(await flushDesktopUsageWaits(runtime, send, new Date('2026-11-16T15:02:00.000Z'))).toEqual([])
    expect(sent).toHaveLength(1)
    expect((await readDesktopUsageWait(runtime, 'a1', 's1')).wait).toBeNull()
})

test('a cancelled message is never sent', async () => {
    const queued = await queueDesktopUsageWait(runtime, message)
    expect(await cancelDesktopUsageWait(runtime, queued.wait!.id)).toBe(true)
    expect((await readDesktopUsageWait(runtime, 'a1', 's1')).wait).toBeNull()
    vi.setSystemTime(AFTER); state.connections = [chatgpt(2), claude, key]
    expect(await flushDesktopUsageWaits(runtime, send, AFTER)).toEqual([])
    expect(sent).toHaveLength(0)
    // And the conversation can queue a message again afterwards.
    expect((await queueDesktopUsageWait(runtime, message)).wait?.state).toBe('waiting')
})

test('a waiting message survives a restart: it lives in the database, not in the window', async () => {
    const queued = await queueDesktopUsageWait(runtime, message)
    vi.resetModules()
    const reopened = await import('./usage-waits')
    expect((await reopened.readDesktopUsageWait(runtime, 'a1', 's1')).wait).toMatchObject({ id: queued.wait!.id, state: 'waiting' })
    vi.setSystemTime(AFTER); state.connections = [chatgpt(2), claude, key]
    expect(await reopened.flushDesktopUsageWaits(runtime, send, AFTER)).toEqual([queued.wait!.id])
})

test('a message the app was sending when it closed is held, not sent a second time', async () => {
    const queued = await queueDesktopUsageWait(runtime, message)
    await db.execute({ sql: "UPDATE desktop_usage_chat_waits SET state='sending' WHERE id=?", args: [queued.wait!.id] })
    vi.resetModules()
    const reopened = await import('./usage-waits')
    vi.setSystemTime(AFTER); state.connections = [chatgpt(2), claude, key]
    expect(await reopened.flushDesktopUsageWaits(runtime, send, AFTER)).toEqual([])
    expect(sent).toHaveLength(0)
    expect((await reopened.readDesktopUsageWait(runtime, 'a1', 's1')).wait).toMatchObject({ state: 'held', reason: expect.stringContaining('Rerun closed while this message was being sent') })
})

test('nothing is sent to a key billed per token on its own', async () => {
    await queueDesktopUsageWait(runtime, message)
    // The conversation now resolves to a paid key, and no backup was picked.
    state.pick = { connectionId: 'openai-key', model: 'gpt-paid' }
    vi.setSystemTime(AFTER)
    expect(await flushDesktopUsageWaits(runtime, send, AFTER)).toEqual([])
    expect(sent).toHaveLength(0)
    expect((await readDesktopUsageWait(runtime, 'a1', 's1')).wait).toMatchObject({ state: 'held', reason: expect.stringContaining('billed per token') })
})

test('stays waiting when the plan is still out at the reset time, until its new reset', async () => {
    const queued = await queueDesktopUsageWait(runtime, message)
    vi.setSystemTime(AFTER); state.connections = [chatgpt(100, '2026-11-18T00:00:00.000Z'), claude, key]
    expect(await flushDesktopUsageWaits(runtime, send, AFTER)).toEqual([])
    expect((await readDesktopUsageWait(runtime, 'a1', 's1')).wait).toMatchObject({ id: queued.wait!.id, state: 'waiting', resetsAt: '2026-11-18T00:00:00.000Z' })
})

test('with no reset time it checks every 15 minutes and gives up after 24 hours with a plain reason', async () => {
    state.connections = [chatgpt(100, null), claude, key]
    const queued = await queueDesktopUsageWait(runtime, message)
    expect(queued.wait).toMatchObject({ resetsAt: null, nextCheckAt: '2026-11-16T10:15:00.000Z' })
    const at = (hours: number) => new Date(START.getTime() + hours * 3_600_000)
    vi.setSystemTime(at(1)); await flushDesktopUsageWaits(runtime, send, at(1))
    expect((await readDesktopUsageWait(runtime, 'a1', 's1')).wait).toMatchObject({ state: 'waiting', nextCheckAt: '2026-11-16T11:15:00.000Z' })
    vi.setSystemTime(at(24)); await flushDesktopUsageWaits(runtime, send, at(24))
    expect(sent).toHaveLength(0)
    expect((await readDesktopUsageWait(runtime, 'a1', 's1')).wait).toMatchObject({ state: 'held', reason: 'Skipped: ChatGPT was still out of usage after 24 hours.' })
})

test('the backup model the owner picked sends the waiting message without waiting for the reset', async () => {
    const queued = await queueDesktopUsageWait(runtime, message)
    expect(await flushDesktopUsageWaits(runtime, send, new Date('2026-11-16T10:05:00.000Z'))).toEqual([])
    await saveDesktopBackupModel(runtime, state.connections as ConnectionSummary[], { connectionId: 'mac-claude', model: 'claude-opus-5-5' })
    expect(await flushDesktopUsageWaits(runtime, send, new Date('2026-11-16T10:06:00.000Z'))).toEqual([queued.wait!.id])
    expect(sent).toHaveLength(1)
})

test('refuses to queue when the conversation is not waiting for a plan', async () => {
    state.pick = { connectionId: 'openai-key', model: 'gpt-paid' }
    await expect(queueDesktopUsageWait(runtime, message)).rejects.toThrow('not waiting for a plan')
})

test('a conversation that was deleted while waiting gets nothing sent', async () => {
    await queueDesktopUsageWait(runtime, message)
    state.sessions.clear()
    vi.setSystemTime(AFTER); state.connections = [chatgpt(2), claude, key]
    expect(await flushDesktopUsageWaits(runtime, send, AFTER)).toEqual([])
    expect(sent).toHaveLength(0)
})
