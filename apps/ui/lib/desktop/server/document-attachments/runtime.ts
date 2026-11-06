import 'server-only'
import type { Client } from '@libsql/client'
import { getAgent } from '@/lib/engine/client'
import { desktopDocumentScopeSchema, type DesktopDocumentScope } from '@rerun/contracts'
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

export async function createDesktopDocumentRuntime(runtime: DesktopRuntime, db: Client, ports: {
    isCurrent: () => boolean
    agent?: (id: string, signal: AbortSignal) => Promise<{ id: string; enabled: boolean }>
} = { isCurrent: () => true }) {
    await ensureDesktopDocumentAttachmentsSchema(db)
    const store = desktopDocumentStore(db), auxiliary = desktopAuxiliaryStore(db), backends = desktopAuxiliaryBackends(auxiliary)
    const current = (signal: AbortSignal) => { signal.throwIfAborted(); if (!ports.isCurrent()) throw new DesktopHttpError(409, 'This app session changed. Reopen the attachment.') }
    const unavailable = () => new DesktopHttpError(409, 'This attachment conversation is no longer available.')
    async function baseOwner(scope: DesktopDocumentScope, signal: AbortSignal, mutable = true) {
        desktopDocumentScopeSchema.parse(scope); current(signal)
        const local = await findDesktopAgent(db, scope.agentId)
        if (!local || local.workspaceId !== runtime.workspaceId || mutable && !local.enabled) throw unavailable()
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
        const tab = (await readDesktopChats(db, agent.id)).tabs?.tabs.find(item => item.uid === scope.tabUid)
        if (!tab) throw unavailable()
        if (scope.sessionId) {
            const session = await findDesktopSession(db, scope.sessionId)
            if (tab.id !== scope.sessionId || session?.agentId !== agent.id) throw unavailable()
        } else if (tab.id !== null && !await firstSession(scope, tab.id)) throw unavailable()
        current(signal)
    }
    return createDesktopDocumentAttachmentService({
        store, blobs: desktopDocumentBlobs(db), owner,
        readScopes: async (scope, signal) => { await owner(scope, signal); return scope.sessionId && await firstSession(scope, scope.sessionId) ? [scope, { agentId: scope.agentId, tabUid: scope.tabUid }] : [scope] },
        readOwner: async (scope, id, signal) => {
            await baseOwner(scope, signal, false)
            const record = await store.read(scope, id)
            if (!record || record.deletion) throw unavailable()
            // Admission is an immutable owner-bound retention receipt. History
            // stays readable after the original tab closes, without retargeting it.
            if (!record.attachment.admitted) await owner(scope, signal)
            current(signal)
        },
        references: async (scope, id) => {
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
