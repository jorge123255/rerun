import 'server-only'
import type { Client } from '@libsql/client'
import { visibleText, parseVoiceMessage, desktopVoiceScopeSchema, type DesktopVoiceScope, type DesktopVoiceSendInput } from '@rerun/contracts'
import { getAgent, getRun, getSessionMessages } from '@/lib/engine/client'
import { startDesktopChat } from '../engine'
import { engineOf } from '../settings'
import type { DesktopRuntime } from '../runtime'
import { findDesktopAgent, findDesktopSession, listDesktopSessions } from '../store'
import { readDesktopChats } from '../session-tabs'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { desktopAuxiliaryStore } from '../auxiliary/store'
import { desktopAuxiliaryBackends } from '../auxiliary/backends'
import { desktopVoiceAudioReference, buildDesktopVoiceMessage } from '../../voice/voice'
import { DesktopHttpError } from '../auth'
import { createDesktopVoiceService } from './service'
import { desktopVoiceStore, ensureDesktopVoiceSchema } from './store'
import { desktopVoiceBlobs, desktopVoiceDispatches } from './storage'

export type VoiceBackendPorts = {
    agent: (engineAgentId: string, signal: AbortSignal) => Promise<{ id: string; enabled: boolean }>
    messages: (engineAgentId: string, engineSessionId: string, signal: AbortSignal) => Promise<Array<{ id: string; role: string; contentJson: string }>>
    run: (engineAgentId: string, runId: string, signal: AbortSignal) => Promise<{ id: string; agentId: string; sessionId: string | null }>
    startChat: typeof startDesktopChat
    isCurrent: () => boolean
    transcriptionAvailable: () => Promise<boolean>
    transcribe: (bytes: Uint8Array, format: string, signal: AbortSignal) => Promise<string>
}
const unavailable = () => new DesktopHttpError(409, 'This voice conversation is no longer current.')
function textOf(row: { contentJson: string }) {
    try { return visibleText(JSON.parse(row.contentJson), '') } catch { throw unavailable() }
}

/** Uses the app's own database, authenticated engine client and encrypted auxiliary credential. */
export async function createDesktopVoiceRuntime(runtime: DesktopRuntime, db: Client, overrides: Partial<VoiceBackendPorts> = {}) {
    await ensureDesktopVoiceSchema(db)
    const conn = engineOf(runtime), auxiliary = desktopAuxiliaryStore(db), backends = desktopAuxiliaryBackends(auxiliary)
    const ports: VoiceBackendPorts = {
        agent: async (id, signal) => { signal.throwIfAborted(); const row = await getAgent(conn, id); signal.throwIfAborted(); return { id: row.id, enabled: row.config.enabled } },
        messages: (agent, session, signal) => getSessionMessages(conn, agent, session, { requireSuccess: true, signal }),
        run: (agent, run, signal) => getRun(conn, agent, run, { signal }),
        startChat: startDesktopChat,
        isCurrent: () => true,
        transcriptionAvailable: async () => (await auxiliary.list()).some(value => value.purpose === 'transcription' && value.configured),
        transcribe: (bytes, format, signal) => backends.transcribe(bytes, format, signal),
        ...overrides,
    }
    const store = desktopVoiceStore(db), blobs = desktopVoiceBlobs(db), dispatches = desktopVoiceDispatches(db)
    function current(signal: AbortSignal) { signal.throwIfAborted(); if (!ports.isCurrent()) throw unavailable() }
    async function baseOwner(scope: DesktopVoiceScope, signal: AbortSignal, mutable: boolean) {
        desktopVoiceScopeSchema.parse(scope); current(signal)
        const agent = await findDesktopAgent(db, scope.agentId)
        // The authenticated runtime selects the database; each database keeps
        // its own workspace row 1, including runtime workspaces 2 and later.
        if (!agent || agent.workspaceId !== 1 || mutable && !agent.enabled) throw unavailable()
        await assertCoworkerNotDeleting(db, agent.id)
        const engine = await ports.agent(agent.engineAgentId, signal)
        current(signal)
        const fresh = await findDesktopAgent(db, scope.agentId)
        if (!fresh || fresh.engineAgentId !== agent.engineAgentId || engine.id !== agent.engineAgentId || mutable && (!fresh.enabled || !engine.enabled)) throw unavailable()
        await assertCoworkerNotDeleting(db, agent.id)
        current(signal)
        return fresh
    }
    async function owner(scope: DesktopVoiceScope, signal: AbortSignal) {
        const agent = await baseOwner(scope, signal, true)
        const chats = await readDesktopChats(db, agent.id)
        const tab = chats.tabs?.tabs.find(value => value.uid === scope.tabUid)
        if (!tab) throw unavailable()
        if (scope.sessionId) {
            if (tab.id !== scope.sessionId) throw unavailable()
            const session = await findDesktopSession(db, scope.sessionId)
            if (!session || session.agentId !== agent.id) throw unavailable()
        } else if (tab.id !== null) {
            // A first-send recording keeps its original blank-tab scope. Only that
            // tab's canonical first-turn mapping can authorize its later recovery.
            const first = (await db.execute({ sql: 'SELECT s.id FROM desktop_tab_starts t JOIN desktop_sessions s ON s.engine_session_id=t.engine_session_id AND s.agent_id=t.agent_id WHERE t.agent_id=? AND t.uid=? AND s.id=?', args: [agent.id, scope.tabUid, tab.id] })).rows[0]
            if (!first) throw unavailable()
        }
        current(signal)
        return agent
    }
    async function readScopes(scope: DesktopVoiceScope, signal: AbortSignal): Promise<DesktopVoiceScope[]> {
        const agent = await owner(scope, signal)
        if (!scope.sessionId) return [scope]
        const first = (await db.execute({ sql: 'SELECT t.run_id FROM desktop_tab_starts t JOIN desktop_sessions s ON s.engine_session_id=t.engine_session_id AND s.agent_id=t.agent_id WHERE t.agent_id=? AND t.uid=? AND s.id=?', args: [agent.id, scope.tabUid, scope.sessionId] })).rows[0]
        if (!first) return [scope]
        const incompatible = (await db.execute({ sql: "SELECT 1 FROM desktop_voice_dispatches WHERE agent_id=? AND tab_uid=? AND original_session_id IS NULL AND (engine_agent_id<>? OR (phase='complete' AND (session_id<>? OR run_id<>?))) LIMIT 1", args: [agent.id, scope.tabUid, agent.engineAgentId, scope.sessionId, String(first.run_id)] })).rows.length
        if (incompatible) throw unavailable()
        current(signal)
        return [scope, { agentId: scope.agentId, tabUid: scope.tabUid }]
    }
    async function sentAudio(scope: DesktopVoiceScope, attemptId: string, signal: AbortSignal) {
        const agent = await baseOwner(scope, signal, false)
        const record = await store.read(scope, attemptId)
        let sent = await dispatches.read(scope, attemptId)
        if (!record || record.deletion) throw unavailable()
        if (sent && sent.engineAgentId !== agent.engineAgentId) throw unavailable()
        // Recover an accepted send without replaying it. This permits a saved
        // bubble to play even when acknowledgement was lost before the tab closed.
        if (sent && !sent.dispatch && sent.engineAgentId === agent.engineAgentId) {
            try {
            const first = !scope.sessionId ? (await db.execute({ sql: 'SELECT s.id,t.run_id FROM desktop_tab_starts t JOIN desktop_sessions s ON s.agent_id=t.agent_id AND s.engine_session_id=t.engine_session_id WHERE t.agent_id=? AND t.uid=?', args: [agent.id, scope.tabUid] })).rows[0] : null
            const sessionId = scope.sessionId ?? (first ? String(first.id) : null)
            const runId = scope.sessionId ? attemptId : first ? String(first.run_id) : null
            const session = sessionId ? await findDesktopSession(db, sessionId) : null
            if (session && runId && session.agentId === agent.id) {
                const run = await ports.run(agent.engineAgentId, runId, signal)
                const text = buildDesktopVoiceMessage(scope, record.draft.recording, record.draft.transcript ?? '')
                const messages = await ports.messages(agent.engineAgentId, session.engineSessionId, signal)
                if (run.id === runId && run.agentId === agent.engineAgentId && run.sessionId === session.engineSessionId && messages.some(message => message.role === 'user' && textOf(message) === text)) {
                    await baseOwner(scope, signal, false)
                    await dispatches.complete(scope, attemptId, sent.fingerprint, { sessionId: session.id, runId }, null)
                    sent = await dispatches.read(scope, attemptId)
                }
            }
            } catch {
                // No receipt is asserted. An unsent recording still belongs to
                // its open tab even when the engine cannot prove a pending run.
                await owner(scope, signal)
                return
            }
        }
        if (!sent?.dispatch) { await owner(scope, signal); return }
        if (sent.engineAgentId !== agent.engineAgentId) throw unavailable()
        const session = await findDesktopSession(db, sent.dispatch.sessionId)
        if (!session || session.agentId !== agent.id) throw unavailable()
        const run = await ports.run(agent.engineAgentId, sent.dispatch.runId, signal)
        if (run.id !== sent.dispatch.runId || run.agentId !== agent.engineAgentId || run.sessionId !== session.engineSessionId) throw unavailable()
        const text = buildDesktopVoiceMessage(scope, record.draft.recording, record.draft.transcript ?? '')
        const rows = await ports.messages(agent.engineAgentId, session.engineSessionId, signal)
        if (!rows.some(row => row.role === 'user' && (!sent.messageId || row.id === sent.messageId) && textOf(row) === text)) throw unavailable()
        await baseOwner(scope, signal, false)
    }
    const send = async (input: DesktopVoiceSendInput & { signal: AbortSignal }) => {
        const agent = await owner(input.scope, input.signal)
        if (input.scope.sessionId && input.modelChoice) throw new DesktopHttpError(409, 'Saved conversations use their saved model.')
        await blobs.read(input.scope, input.recording, input.signal)
        const reserved = await dispatches.reserve(input, agent.engineAgentId)
        if (reserved.dispatch) return { dispatch: reserved.dispatch, messageId: reserved.messageId }
        const fresh = await owner(input.scope, input.signal)
        if (fresh.engineAgentId !== reserved.engineAgentId) throw unavailable()
        const chatInput = input.scope.sessionId
            ? { agentId: agent.id, sessionId: input.scope.sessionId, requestId: input.attemptId, text: input.text }
            : { agentId: agent.id, tabUid: input.scope.tabUid, text: input.text, ...(reserved.modelChoice && { modelChoice: reserved.modelChoice }) }
        // Canonical first-tab/queued receipts perform replay before a new admission.
        // Never invent a new UUID when acknowledgement was lost.
        const started = await ports.startChat(runtime, chatInput)
        let dispatch: { sessionId: string; runId: string }
        try {
            const runId = started.response.headers.get('x-run-id')
            if (!started.response.ok || !runId || started.response.headers.get('x-session-id') !== started.sessionId || input.scope.sessionId && started.sessionId !== input.scope.sessionId) throw unavailable()
            const session = await findDesktopSession(db, started.sessionId)
            const currentAgent = await findDesktopAgent(db, agent.id)
            if (!session || session.agentId !== agent.id || currentAgent?.engineAgentId !== reserved.engineAgentId) throw unavailable()
            dispatch = { sessionId: started.sessionId, runId }
            // The exact accepted receipt is durable even if the HTTP caller disconnected.
            await dispatches.complete(input.scope, input.attemptId, reserved.fingerprint, dispatch, null)
        } finally { await started.response.body?.cancel().catch(() => {}) }
        current(input.signal)
        return { messageId: null, dispatch }
    }
    return createDesktopVoiceService({
        store, blobs, owner: async (scope, signal) => { await owner(scope, signal) }, readScopes, audioOwner: sentAudio, send,
        transcriptionAvailable: ports.transcriptionAvailable,
        transcribe: ({ bytes, format, signal }) => ports.transcribe(bytes, format, signal),
        references: async (scope, attemptId) => {
            if (await dispatches.read(scope, attemptId)) return true
            const signal = AbortSignal.timeout(25_000), agent = await owner(scope, signal)
            const reference = desktopVoiceAudioReference(scope, attemptId)
            const queued = await db.execute({ sql: "SELECT 1 FROM desktop_queued_messages WHERE agent_id=? AND instr(json_extract(payload,'$.text'),?)>0 UNION ALL SELECT 1 FROM desktop_composer_drafts WHERE agent_id=? AND instr(text,?)>0 LIMIT 1", args: [scope.agentId, reference, scope.agentId, reference] })
            if (queued.rows.length) return true
            const sessions = await listDesktopSessions(db, scope.agentId)
            if (sessions.length > 200) throw new DesktopHttpError(409, 'This recording cannot be removed until its saved references can be verified.')
            for (const session of sessions) {
                const rows = await ports.messages(agent.engineAgentId, session.engineSessionId, signal)
                if (rows.some(row => row.role === 'user' && parseVoiceMessage(textOf(row))?.src === reference)) return true
                await owner(scope, signal)
            }
            return false
        },
    })
}
