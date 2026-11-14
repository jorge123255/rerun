import 'server-only'
import type { Client } from '@libsql/client'
import { getAgent } from '@/lib/engine/client'
import { desktopDocumentScopeSchema, FOREMAN_AGENT_ID, type DesktopDocumentScope } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { findDesktopAgent, findDesktopSession } from '../store'
import { readDesktopChats } from '../session-tabs'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { desktopAuxiliaryStore } from '../auxiliary/store'
import { desktopAuxiliaryBackends } from '../auxiliary/backends'
import { extractDesktopPdfText } from '../pdf-text'
import { createDesktopDocumentAttachmentService } from './service'
import { desktopDocumentStore, ensureDesktopDocumentAttachmentsSchema } from './store'
import { desktopDocumentBlobs } from './storage'
import { questionDocumentId } from '../../question-documents'
import { ownedForemanChat } from '../foreman/chat-store'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'

export async function createDesktopDocumentRuntime(runtime: DesktopRuntime, db: Client, ports: {
    isCurrent: () => boolean
    agent?: (id: string, signal: AbortSignal) => Promise<{ id: string; enabled: boolean }>
} = { isCurrent: () => true }, kind: 'coworker' | 'foreman' = 'coworker') {
    await ensureDesktopDocumentAttachmentsSchema(db)
    const store = desktopDocumentStore(db, kind), auxiliary = desktopAuxiliaryStore(db), backends = desktopAuxiliaryBackends(auxiliary)
    const current = (signal: AbortSignal) => { signal.throwIfAborted(); if (!ports.isCurrent()) throw new DesktopHttpError(409, 'This app session changed. Reopen the attachment.') }
    const unavailable = () => new DesktopHttpError(409, 'This attachment conversation is no longer available.')
    async function baseOwner(scope: DesktopDocumentScope, signal: AbortSignal, mutable = true) {
        desktopDocumentScopeSchema.parse(scope); current(signal)
        if (scope.agentId === FOREMAN_AGENT_ID || scope.questionId) throw unavailable()
        const local = await findDesktopAgent(db, scope.agentId)
        // The authenticated runtime opens this database from its own data root.
        // Inside that database the coworker row is workspace 1. The external
        // runtime workspace id is not a second row id, and a row stored under
        // another workspace id is not this database's owner.
        if (!local || local.workspaceId !== 1 || mutable && !local.enabled) throw unavailable()
        await assertCoworkerNotDeleting(db, local.id)
        const engine = ports.agent ? await ports.agent(local.engineAgentId, signal) : await getAgent(engineOf(runtime), local.engineAgentId).then(row => ({ id: row.id, enabled: row.config.enabled }))
        const fresh = await findDesktopAgent(db, local.id)
        current(signal)
        if (!fresh || fresh.engineAgentId !== local.engineAgentId || engine.id !== local.engineAgentId || mutable && (!fresh.enabled || !engine.enabled)) throw unavailable()
        await assertCoworkerNotDeleting(db, local.id); current(signal)
        return fresh
    }
    async function firstSession(scope: DesktopDocumentScope, sessionId: string) {
        return (await db.execute({ sql: 'SELECT s.id FROM desktop_tab_starts t JOIN desktop_sessions s ON s.engine_session_id=t.engine_session_id AND s.agent_id=t.agent_id WHERE t.agent_id=? AND t.uid=? AND s.id=?', args: [scope.agentId, scope.tabUid, sessionId] })).rows.length > 0
    }
    async function owner(scope: DesktopDocumentScope, signal: AbortSignal) {
        const agent = await baseOwner(scope, signal)
        const questionId = questionDocumentId(scope.tabUid)
        if (questionId) {
            if (!scope.sessionId) throw unavailable()
            const { requireDesktopPendingQuestion } = await import('../questions')
            const target = await requireDesktopPendingQuestion(runtime, scope.sessionId, questionId, signal, true)
            if (target.agent.id !== agent.id || target.agent.engineAgentId !== agent.engineAgentId) throw unavailable()
            current(signal)
            return
        }
        const tab = (await readDesktopChats(db, agent.id)).tabs?.tabs.find(item => item.uid === scope.tabUid)
        if (!tab) throw unavailable()
        if (scope.sessionId) {
            const session = await findDesktopSession(db, scope.sessionId)
            if (tab.id !== scope.sessionId || session?.agentId !== agent.id) throw unavailable()
        } else if (tab.id !== null && !await firstSession(scope, tab.id)) throw unavailable()
        current(signal)
    }
    async function foremanOwner(scope: DesktopDocumentScope, signal: AbortSignal, historyId?: string) {
        current(signal)
        if (scope.agentId !== FOREMAN_AGENT_ID || !scope.sessionId) throw unavailable()
        const owner = await ownedForemanChat(db, { workspaceId: String(runtime.workspaceId), chatId: scope.tabUid })
        if (owner.sessionId !== scope.sessionId) throw unavailable()
        if (scope.questionId) {
            const stored = historyId ? await store.read(scope, historyId) : null
            if (!stored?.attachment.admitted) {
                assertDesktopWorkspaceAdmission(runtime)
                const { readPendingForemanRequests } = await import('../foreman/question')
                const { question } = await readPendingForemanRequests(runtime, owner, signal)
                if (question?.view.id !== scope.questionId) throw unavailable()
                assertDesktopWorkspaceAdmission(runtime)
            }
        }
        current(signal)
    }
    return createDesktopDocumentAttachmentService({
        store, blobs: desktopDocumentBlobs(db, kind),
        allowChatImages: kind === 'foreman',
        owner: kind === 'foreman' ? async (scope, signal) => {
            assertDesktopWorkspaceAdmission(runtime)
            await foremanOwner(scope, signal)
            assertDesktopWorkspaceAdmission(runtime)
        } : owner,
        readScopes: kind === 'foreman' ? undefined : async (scope, signal) => {
            await owner(scope, signal)
            return scope.sessionId && await firstSession(scope, scope.sessionId) ? [scope, { agentId: scope.agentId, tabUid: scope.tabUid }] : [scope]
        },
        readOwner: async (scope, id, signal) => {
            if (kind === 'foreman') return foremanOwner(scope, signal, id)
            await baseOwner(scope, signal, false)
            const record = await store.read(scope, id)
            if (!record || record.deletion) throw unavailable()
            // Admission is an immutable owner-bound retention receipt. History
            // stays readable after the original tab closes, without retargeting it.
            if (!record.attachment.admitted) await owner(scope, signal)
            current(signal)
        },
        references: async (scope, id) => {
            if (kind === 'foreman') {
                const rows = await db.execute({ sql: 'SELECT 1 FROM desktop_foreman_turns WHERE chat_id=? AND instr(body,?)>0 LIMIT 1', args: [scope.tabUid, id] })
                return rows.rows.length > 0
            }
            const rows = await db.execute({ sql: 'SELECT 1 FROM desktop_queued_messages WHERE agent_id=? AND instr(payload,?)>0 UNION ALL SELECT 1 FROM desktop_composer_drafts WHERE agent_id=? AND instr(text,?)>0 LIMIT 1', args: [scope.agentId, id, scope.agentId, id] })
            return rows.rows.length > 0
        },
        extractPdfText: async (bytes, signal) => {
            const extract = await extractDesktopPdfText(bytes, { signal })
            if (extract.truncated) throw new DesktopHttpError(413, 'This PDF contains more text than the app can send. Use a shorter document.')
            return extract.pages.map(page => page.text).join('\n\n')
        },
        transcriptionAvailable: async attachment => attachment.byteLength <= 8 * 1024 * 1024 && /\.(?:wav|mp3|m4a|ogg)$/i.test(attachment.name) && (await auxiliary.list()).some(item => item.purpose === 'transcription' && item.configured),
        transcribeAudio: ({ bytes, name, signal }) => backends.transcribe(bytes, name.split('.').at(-1)!.toLowerCase(), signal),
    })
}
