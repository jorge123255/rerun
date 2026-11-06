import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindDesktopTriggers } from './binding.js'
import { desktopTriggerHistory } from './history.js'
import type { DesktopTriggerAuthority } from './types.js'
import { withAgentLock } from '../../agents/lock.js'
import { withKeyedLock } from '../../lib/lock.js'
import { settleDesktopTriggerOutcome } from './dispatch.js'
import { stopDesktopTriggerRun } from './stop.js'

const disk = vi.hoisted(() => ({ client: null as Client | null }))
vi.mock('../../db/systemDb.js', () => ({
    getSystemDb: async () => {
        const { drizzle } = await import('drizzle-orm/libsql')
        return { client: disk.client!, db: drizzle(disk.client!) }
    },
}))

let directory: string
let file: string
const startTriggerRun = vi.fn<DesktopTriggerAuthority['startTriggerRun']>(async () => { throw new Error('History must not launch a run') })
const cancelExactRun = vi.fn<DesktopTriggerAuthority['cancelExactRun']>(async () => { throw new Error('History must not cancel a run') })
const authority: DesktopTriggerAuthority = {
    assertActive() {},
    resolveOwnerByEngineId: async () => ({ localAgentId: 'local', engineAgentId: 'engine', enabled: true, deleting: false }),
    assertTriggerGrant: async () => {},
    assertSetupClear: async () => {},
    resolveAutomationModel: async () => { throw new Error('History must not resolve a model') },
    startTriggerRun, cancelExactRun,
    async readRun(_agentId, runId) {
        const row = (await disk.client!.execute({ sql: 'SELECT * FROM runs WHERE id=?', args: [runId] })).rows[0]
        return row ? { id: String(row.id), agentId: String(row.agent_id), sessionId: String(row.session_id), status: String(row.status),
            triggerSource: row.trigger_source == null ? null : String(row.trigger_source), triggerSlug: row.trigger_slug == null ? null : String(row.trigger_slug) } : null
    },
    readSession: async () => ({ id: 'session', agentId: 'engine', source: 'trigger', title: 'Hook' }),
    adoptTriggerSession: async () => { throw new Error('The original chat is already adopted') },
    routeHuman: async () => { throw new Error('History must not dispatch a human decision') },
    ingressOrigin: () => ({ enabled: false, origin: null, bindHost: '127.0.0.1', bindPort: null, hostingDecision: 'unresolved' }),
    listTriggers: async () => [],
    readTrigger: async () => null,
    writeTrigger: async () => { throw new Error('History must not change definitions') },
    rotateTriggerToken: async () => { throw new Error('History must not change definitions') },
    deleteTrigger: async () => { throw new Error('History must not change definitions') },
    markFired: async () => { throw new Error('History must not fire a webhook') },
}
function reopen() {
    disk.client?.close()
    disk.client = createClient({ url: `file:${file}` })
    return bindDesktopTriggers({ getSystemClient: async () => disk.client!, authority })
}
beforeEach(async () => {
    vi.clearAllMocks()
    directory = await mkdtemp(join(tmpdir(), 'rerun-trigger-history-'))
    file = join(directory, 'system.db')
    const binding = reopen()
    await disk.client!.executeMultiple(`
        CREATE TABLE runs(id TEXT PRIMARY KEY,agent_id TEXT,session_id TEXT,status TEXT,trigger_source TEXT,trigger_slug TEXT);
        CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,role TEXT,content_json TEXT,tool_calls_json TEXT,sources_json TEXT,created_at TEXT,author_id TEXT,author_name TEXT);
        CREATE TABLE tool_calls(agent_id TEXT,session_id TEXT,run_id TEXT,tool_call_id TEXT,tool_name TEXT,is_error INTEGER);
        INSERT INTO runs VALUES('original','engine','session','done','trigger','hook');
    `)
    await binding.store.initialize('engine')
    // The engine saved the completed turn, but quit before the fire callback saved its outcome.
    await binding.store.recordEvent({ eventId: 'event', attemptFingerprint: null, localAgentId: 'local', engineAgentId: 'engine', slug: 'hook',
        triggerName: 'Hook', method: 'POST', receivedAt: '2026-11-06T00:00:00.000Z', status: 'running', localSessionId: 'local-session',
        engineSessionId: 'session', runId: 'original', revision: 'revision', error: null, payloadBytes: 0, truncated: false, capturedPayload: true, payloadPreview: '' })
})
afterEach(async () => {
    disk.client?.close(); disk.client = null
    await rm(directory, { recursive: true, force: true })
})
async function saveForm(kind: 'question' | 'approval', runId = 'original') {
    const toolName = kind === 'question' ? 'ask_user' : 'request_approval'
    const input = kind === 'question' ? { questions: [{ question: 'What number should I add to 17?' }] }
        : { approvals: [{ action: 'Show the arithmetic result', detail: 'Only print the result in this chat.' }] }
    const content = [{ type: 'tool-call', toolCallId: 'human-call', toolName, input },
        { type: 'tool-result', toolCallId: 'human-call', output: { status: 'delivered' } }]
    await disk.client!.batch([
        { sql: "INSERT INTO messages(id,session_id,role,content_json,created_at) VALUES('human-message','session','assistant',?,'2026-11-06T00:00:01.000Z')", args: [JSON.stringify(content)] },
        { sql: "INSERT INTO tool_calls VALUES('engine','session',?,'human-call',?,0)", args: [runId, toolName] },
    ], 'write')
}

describe('webhook history from durable human-request transcripts', () => {
    it('allows a roster mutation to reach the agent lock while chat adoption waits for the roster', async () => {
        await disk.client!.execute('UPDATE desktop_trigger_events SET local_session_id=NULL')
        let entered!: () => void, held!: () => void
        const adoptionEntered = new Promise<void>(resolve => { entered = resolve })
        const rosterHeld = new Promise<void>(resolve => { held = resolve })
        const roster = withKeyedLock('trigger-history-test-roster', async () => {
            held()
            await adoptionEntered
            await withAgentLock('engine', async () => {})
        })
        await rosterHeld
        const adopt = vi.fn<DesktopTriggerAuthority['adoptTriggerSession']>(async input => {
            entered()
            return withKeyedLock('trigger-history-test-roster', async () => ({ agentId: input.localAgentId, engineAgentId: input.engineAgentId,
                sessionId: 'adopted-chat', engineSessionId: input.engineSessionId, runId: input.runId, tabUid: 'adopted-tab', title: 'Hook' }))
        })
        const binding = bindDesktopTriggers({ getSystemClient: async () => disk.client!, authority: { ...authority, adoptTriggerSession: adopt } })
        await Promise.all([desktopTriggerHistory(binding, 'engine'), roster])
        expect((await binding.store.getEvent('engine', 'event'))?.localSessionId).toBe('adopted-chat')
        expect(adopt).toHaveBeenCalledTimes(1)
    })

    it.each(['owner', 'run', 'stop'] as const)('does not attach a returned chat after its %s changes during adoption', async changed => {
        await disk.client!.execute('UPDATE desktop_trigger_events SET local_session_id=NULL')
        let localAgentId = 'local'
        const binding = bindDesktopTriggers({ getSystemClient: async () => disk.client!, authority: { ...authority,
            resolveOwnerByEngineId: async () => ({ engineAgentId: 'engine', localAgentId, enabled: true, deleting: false }),
            adoptTriggerSession: async input => {
                await withAgentLock('engine', async () => {
                    if (changed === 'owner') localAgentId = 'replacement-owner'
                    else if (changed === 'run') await disk.client!.execute("UPDATE desktop_trigger_events SET run_id='replacement-run'")
                    else await disk.client!.execute("UPDATE desktop_trigger_events SET stop_request_id='saved-stop'")
                })
                return { agentId: input.localAgentId, engineAgentId: input.engineAgentId, sessionId: 'late-chat', engineSessionId: input.engineSessionId,
                    runId: input.runId, tabUid: 'late-tab', title: 'Hook' }
            },
        } })
        await desktopTriggerHistory(binding, 'engine')
        expect((await binding.store.getEvent('engine', 'event'))?.localSessionId).toBeNull()
    })

    it.each(['question', 'approval'] as const)('restores an unanswered %s after the first settlement acknowledgement was lost', async kind => {
        await saveForm(kind)
        const restarted = reopen()
        await restarted.recoverOwner('engine')
        expect(await restarted.store.getEvent('engine', 'event')).toMatchObject({ status: 'needs-input', pendingToolCallId: 'human-call', runId: 'original', engineSessionId: 'session' })
        const secondRestart = reopen()
        const history = await desktopTriggerHistory(secondRestart, 'engine')
        expect(history.items).toHaveLength(1)
        expect(history.items[0]).toMatchObject({ eventId: 'event', status: 'needs-input', localSessionId: 'local-session', runId: 'original' })
        expect(history.pending).toEqual([{ eventId: 'event', localSessionId: 'local-session', engineSessionId: 'session', toolCallId: 'human-call' }])
        expect(startTriggerRun).not.toHaveBeenCalled()
        expect(cancelExactRun).not.toHaveBeenCalled()
    })

    it('corrects a previously misclassified original done run even with no continuation admissions', async () => {
        await saveForm('question')
        await disk.client!.execute("UPDATE desktop_trigger_events SET status='finished',pending_tool_call_id=NULL")
        const history = await desktopTriggerHistory(reopen(), 'engine')
        expect(history.items[0]?.status).toBe('needs-input')
        expect(history.pending[0]?.toolCallId).toBe('human-call')
    })

    it('reconciles a lost settlement during a live history read without claiming a second delivery', async () => {
        await saveForm('approval')
        const binding = reopen()
        expect((await desktopTriggerHistory(binding, 'engine')).items[0]?.status).toBe('needs-input')
        expect(await binding.store.getEvent('engine', 'event')).toMatchObject({ status: 'needs-input', pendingToolCallId: 'human-call' })
        expect((await binding.store.listEvents('engine')).map(row => row.eventId)).toEqual(['event'])
        expect(startTriggerRun).not.toHaveBeenCalled()
    })

    it.each(['foreign-run', 'ambiguous', 'read-failure'] as const)('keeps %s evidence uncertain instead of showing Done or an unowned form', async failure => {
        await saveForm('question', failure === 'foreign-run' ? 'unadmitted-run' : 'original')
        if (failure === 'ambiguous') await disk.client!.execute("INSERT INTO tool_calls VALUES('engine','session','other-run','human-call','ask_user',0)")
        if (failure === 'read-failure') await disk.client!.execute('DROP TABLE messages')
        const binding = reopen()
        await binding.recoverOwner('engine')
        expect((await binding.store.getEvent('engine', 'event'))?.status).toBe('uncertain')
        const history = await desktopTriggerHistory(binding, 'engine')
        expect(history.items[0]?.status).toBe('uncertain')
        expect(history.pending).toEqual([])
        expect(startTriggerRun).not.toHaveBeenCalled()
    })

    it('still recognizes a completed run with no unanswered form', async () => {
        await saveForm('question')
        await disk.client!.execute("INSERT INTO messages(id,session_id,role,content_json,created_at) VALUES('answer','session','user','\"25\"','2026-11-06T00:00:02.000Z')")
        const binding = reopen()
        await binding.recoverOwner('engine')
        expect(await binding.store.getEvent('engine', 'event')).toMatchObject({ status: 'finished', pendingToolCallId: null })
        expect((await desktopTriggerHistory(binding, 'engine')).pending).toEqual([])
    })

    it('persists final completion after exact question and approval continuations while preserving the original receipt', async () => {
        await saveForm('question')
        await disk.client!.executeMultiple(`
            UPDATE desktop_trigger_events SET status='needs-input',pending_tool_call_id='human-call';
            INSERT INTO runs VALUES('answer-run','engine','session','done','chat',NULL);
            INSERT INTO runs VALUES('final-run','engine','session','done','chat',NULL);
            INSERT INTO desktop_trigger_human_admissions VALUES('question-source','event','session','original','human-message','human-call','question','answer-run');
            INSERT INTO desktop_trigger_human_admissions VALUES('approval-source','event','session','answer-run','approval-message','approval-call','approval','final-run');
            INSERT INTO messages(id,session_id,role,content_json,created_at) VALUES('answer','session','user','"25"','2026-11-06T00:00:02.000Z');
            INSERT INTO messages(id,session_id,role,content_json,created_at) VALUES('approval-message','session','assistant','[{"type":"tool-call","toolCallId":"approval-call","toolName":"request_approval","input":{"approvals":[{"action":"Show result"}]}},{"type":"tool-result","toolCallId":"approval-call","output":{"status":"delivered"}}]','2026-11-06T00:00:03.000Z');
            INSERT INTO tool_calls VALUES('engine','session','answer-run','approval-call','request_approval',0);
            INSERT INTO messages(id,session_id,role,content_json,created_at) VALUES('decision','session','user','"Approved"','2026-11-06T00:00:04.000Z');
            INSERT INTO messages(id,session_id,role,content_json,created_at) VALUES('reply','session','assistant','"ROUND34_ARITHMETIC=42"','2026-11-06T00:00:05.000Z');
        `)
        const binding = reopen()
        expect((await desktopTriggerHistory(binding, 'engine')).items[0]?.status).toBe('finished')
        const restarted = reopen()
        expect(await restarted.store.getEvent('engine', 'event')).toMatchObject({ status: 'finished', pendingToolCallId: null, runId: 'original', engineSessionId: 'session' })
        expect((await desktopTriggerHistory(restarted, 'engine')).pending).toEqual([])
        expect(startTriggerRun).not.toHaveBeenCalled()
    })

    it('does not resurrect a stopped human request from its retained transcript', async () => {
        await saveForm('question')
        await disk.client!.execute("UPDATE desktop_trigger_events SET status='cancelled',stop_request_id='stop-receipt',pending_tool_call_id='human-call'")
        const binding = reopen()
        await binding.recoverOwner('engine')
        const history = await desktopTriggerHistory(binding, 'engine')
        expect(history.items[0]?.status).toBe('cancelled')
        expect(history.pending).toEqual([])
        expect(cancelExactRun).not.toHaveBeenCalled()
    })

    it.each(['running', 'uncertain'] as const)('preserves an unfinished Stop across restart from %s without republishing its form', async status => {
        await saveForm('question')
        await disk.client!.execute({ sql: "UPDATE desktop_trigger_events SET status=?,stop_request_id='saved-stop',pending_tool_call_id='human-call'", args: [status] })
        const binding = reopen()
        await binding.recoverOwner('engine')
        expect(await binding.store.getEvent('engine', 'event')).toMatchObject({ status: 'uncertain', stopRequestId: 'saved-stop', pendingToolCallId: null })
        const history = await desktopTriggerHistory(binding, 'engine')
        expect(history.items[0]?.status).toBe('uncertain')
        expect(history.pending).toEqual([])
        expect(cancelExactRun).not.toHaveBeenCalled()
        expect(startTriggerRun).not.toHaveBeenCalled()
    })

    it.each(['stop', 'continuation', 'source-run'] as const)('ignores late initial completion and failure after %s supersedes it', async newer => {
        const binding = reopen()
        if (newer === 'stop') await disk.client!.execute("UPDATE desktop_trigger_events SET status='uncertain',stop_request_id='saved-stop'")
        if (newer === 'continuation') await disk.client!.execute("INSERT INTO desktop_trigger_human_admissions VALUES('source','event','session','original','message','call','question','later-run')")
        if (newer === 'source-run') await disk.client!.execute("UPDATE desktop_trigger_events SET run_id='replacement-run'")
        const before = await binding.store.getEvent('engine', 'event')
        const source = { authority, store: binding.store, engineAgentId: 'engine', localAgentId: 'local', eventId: 'event', sessionId: 'session', runId: 'original', slug: 'hook', revision: 'revision' }
        await settleDesktopTriggerOutcome({ ...source, outcome: { kind: 'done', pendingToolCallId: 'stale-call' } })
        await settleDesktopTriggerOutcome({ ...source, outcome: null })
        expect(await binding.store.getEvent('engine', 'event')).toEqual(before)
    })

    it('settles the exact original run when no Stop or continuation supersedes it', async () => {
        const binding = reopen()
        await settleDesktopTriggerOutcome({ authority, store: binding.store, engineAgentId: 'engine', localAgentId: 'local', eventId: 'event',
            sessionId: 'session', runId: 'original', slug: 'hook', revision: 'revision', outcome: { kind: 'done', pendingToolCallId: 'human-call' } })
        expect(await binding.store.getEvent('engine', 'event')).toMatchObject({ status: 'needs-input', pendingToolCallId: 'human-call', runId: 'original' })
    })

    it('reserves Stop under the agent lock but releases it while the exact run drains', async () => {
        await disk.client!.execute("UPDATE runs SET status='running'")
        const binding = reopen()
        const cancel = vi.fn<DesktopTriggerAuthority['cancelExactRun']>(async () => {
            // A cancelled tool can acquire the agent lock while it unwinds.
            await withAgentLock('engine', async () => { await disk.client!.execute("UPDATE runs SET status='cancelled'") })
            await settleDesktopTriggerOutcome({ authority, store: binding.store, engineAgentId: 'engine', localAgentId: 'local', eventId: 'event',
                sessionId: 'session', runId: 'original', slug: 'hook', revision: 'revision', outcome: { kind: 'cancelled' } })
        })
        const request = { requestId: crypto.randomUUID(), localSessionId: 'local-session', runId: 'original', expectedEventId: 'event' }
        const stop = () => stopDesktopTriggerRun({ authority: { ...authority, cancelExactRun: cancel }, store: binding.store, engineAgentId: 'engine', localAgentId: 'local', body: request })
        expect(await stop()).toMatchObject({ canceled: true, alreadyFinished: false, eventId: 'event' })
        expect(await stop()).toMatchObject({ canceled: true, alreadyFinished: false, eventId: 'event' })
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(await binding.store.getEvent('engine', 'event')).toMatchObject({ status: 'cancelled', stopRequestId: request.requestId })
    })
})
