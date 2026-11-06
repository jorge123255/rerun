import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { desktopVoiceDraftSchema } from '@rerun/contracts'
import {
    FOREMAN_VOICE_MIN_MS, foremanVoiceRequestSchema, foremanVoiceSnapshotSchema, sameForemanVoiceTarget,
    type ForemanVoiceTarget, type ForemanVoiceRequest, type ForemanVoiceSnapshot,
} from '@rerun/contracts'
import { createDesktopVoiceService } from '../voice/service'
import { desktopForeman } from '../foreman/binding'
import { ownedForemanChat, foremanTurn, type ForemanTurn } from '../foreman/chat-store'
import { desktopAuxiliaryStore } from '../auxiliary/store'
import { desktopAuxiliaryBackends } from '../auxiliary/backends'
import { readDesktopProviders, engineOf } from '../settings'
import { usableConnection } from '../../chat-model'
import { getRun } from '@/lib/engine/client'
import type { DesktopRuntime } from '../runtime'
import { DesktopHttpError } from '../auth'
import { foremanVoiceStore, voiceScope, voiceTargetJson } from './store'
import { assertForemanVoiceAdmission } from './admission'

export type ForemanVoiceTurnInput = {
    target: ForemanVoiceTarget; attemptId: string; text: string
    signal: AbortSignal; assertCurrent(): Promise<void>
}
export type CanonicalForemanVoiceSend = (input: ForemanVoiceTurnInput) => Promise<{ runId: string }>
export function canonicalForemanVoiceSend(binding: Awaited<ReturnType<typeof desktopForeman>>): CanonicalForemanVoiceSend {
    const current = binding as typeof binding & { sendVoice?: CanonicalForemanVoiceSend }
    return async input => {
        if (typeof current.sendVoice !== 'function') throw new DesktopHttpError(503, 'Foreman voice send admission is not wired. Your recording is saved.')
        return current.sendVoice(input)
    }
}

export function createForemanVoiceRuntime(runtime: DesktopRuntime, db: Client, ports: {
    isCurrent(): boolean; shutdownSignal: AbortSignal; send: CanonicalForemanVoiceSend
}) {
    const lifetime = new AbortController(), jobs = new Set<Promise<unknown>>()
    const active = new Map<string, { target: ForemanVoiceTarget; controller: AbortController; work?: Promise<unknown> }>()
    const aux = desktopAuxiliaryStore(db), backends = desktopAuxiliaryBackends(aux)
    const changed = () => new DesktopHttpError(409, 'This Foreman chat or selected model is no longer current.')
    const keyOf = (t: ForemanVoiceTarget, id: string) => JSON.stringify([voiceTargetJson(t), id])
    async function drain(work: Promise<unknown>[]) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            await Promise.race([
                Promise.allSettled(work),
                new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new DesktopHttpError(503, 'Foreman voice shutdown is not yet drained.')), 5000) }),
            ])
        } finally { clearTimeout(timer) }
    }
    async function owner(t: ForemanVoiceTarget, signal: AbortSignal, requireModel = true) {
        lifetime.signal.throwIfAborted(); ports.shutdownSignal.throwIfAborted(); signal.throwIfAborted()
        if (!ports.isCurrent() || String(runtime.workspaceId) !== t.chat.workspaceId) throw changed()
        await ownedForemanChat(db, t.chat)
        if (requireModel && !usableConnection((await readDesktopProviders(runtime)).connections, t.model)) throw new DesktopHttpError(409, 'Choose a connected model in Settings.')
        lifetime.signal.throwIfAborted(); ports.shutdownSignal.throwIfAborted(); signal.throwIfAborted()
        if (!ports.isCurrent()) throw changed()
    }
    async function accepted(t: ForemanVoiceTarget, id: string, signal: AbortSignal) {
        const row = await foremanVoiceStore(db, t).row(id)
        if (!row) return null
        const receipt = { target: t, attemptId: id, requestId: id, runId: id, accepted: true as const }
        if (row.accepted_run === id) return receipt
        if (!row.send_requested) return null
        const turn = await foremanTurn(db, id), record = JSON.parse(String(row.record))
        if (!turn || turn.body.binding.chatId !== t.chat.chatId || turn.body.binding.workspaceId !== t.chat.workspaceId
            || !sameForemanVoiceTarget(t, { chat: t.chat, model: turn.body.binding.model }) || turn.body.text !== record.draft.transcript?.trim()) return null
        try {
            const run = await getRun(engineOf(runtime), 'foreman', id, { signal: AbortSignal.any([signal, lifetime.signal, ports.shutdownSignal, AbortSignal.timeout(10_000)]) })
            if (run.id !== id || run.agentId !== 'foreman' || run.sessionId !== turn.body.sessionId) return null
            await db.execute({ sql: 'UPDATE desktop_foreman_voice_attempts SET accepted_run=? WHERE attempt_id=? AND target=?', args: [id, id, voiceTargetJson(t)] })
            return receipt
        } catch { return null }
    }
    async function snapshot(t: ForemanVoiceTarget, id: string, signal: AbortSignal): Promise<ForemanVoiceSnapshot> {
        await owner(t, signal, false)
        const storage = foremanVoiceStore(db, t), row = await storage.row(id)
        const record = row ? JSON.parse(String(row.record)) : null
        let draft = record && record.deletion !== 'complete' ? desktopVoiceDraftSchema.parse(record.draft) : null
        if (draft && !record.deletion) {
            try { await storage.blobs.read(voiceScope(t), draft.recording, signal) }
            catch { draft = { ...draft, phase: 'failed', error: 'Saved audio is unavailable. Retry Save recording with this same take.' } }
        }
        const receipt = await accepted(t, id, signal)
        const setup = (await aux.list()).some(x => x.purpose === 'transcription' && x.configured) ? null : 'transcription' as const
        await owner(t, signal, false)
        return foremanVoiceSnapshotSchema.parse({ target: t, attempt: draft ? {
            attemptId: draft.attemptId, phase: draft.phase, revision: draft.revision, recording: draft.recording,
            transcript: draft.transcript, error: draft.error, messageId: draft.messageId, updatedAt: draft.updatedAt,
        } : null, receipt, setup })
    }
    async function cancelAttempt(t: ForemanVoiceTarget, id: string) {
        const running = active.get(keyOf(t, id))
        running?.controller.abort()
        const identities = await db.execute({ sql: 'SELECT target FROM desktop_foreman_voice_attempts WHERE attempt_id=? UNION ALL SELECT target FROM desktop_foreman_voice_cancellations WHERE attempt_id=?', args: [id, id] })
        if (identities.rows.some(row => String(row.target) !== voiceTargetJson(t))) throw changed()
        await db.execute({ sql: 'INSERT INTO desktop_foreman_voice_cancellations(attempt_id,target) VALUES(?,?) ON CONFLICT DO NOTHING', args: [id, voiceTargetJson(t)] })
        await db.execute({
            sql: `UPDATE desktop_foreman_voice_attempts SET cancelled=1,epoch=epoch+1,
                record=json_set(record,'$.draft.revision',?,'$.draft.phase',CASE
                  WHEN json_extract(record,'$.draft.phase')='sent' THEN 'sent'
                  WHEN json_extract(record,'$.draft.transcript') IS NOT NULL THEN 'ready' ELSE 'review' END)
                WHERE attempt_id=? AND target=?`, args: [randomUUID(), id, voiceTargetJson(t)],
        })
        if (running?.work) await drain([running.work])
    }
    async function perform(request: ForemanVoiceRequest, stop: AbortSignal): Promise<ForemanVoiceSnapshot> {
        const t = request.target, id = request.attemptId
        const signal = AbortSignal.any([stop, lifetime.signal, ports.shutdownSignal, AbortSignal.timeout(120_000)])
        await owner(t, signal, !['read', 'cancel', 'discard'].includes(request.action))
        if (request.action === 'read') return snapshot(t, id, signal)
        if (request.action === 'cancel') { await cancelAttempt(t, id); return snapshot(t, id, signal) }
        const initial = await foremanVoiceStore(db, t).row(id), epoch = initial ? Number(initial.epoch) + 1 : 0
        if (initial?.send_requested && request.action === 'transcribe') throw new DesktopHttpError(409, 'This recording already requested a turn. Refresh its receipt or retry the same send.')
        if (initial && request.action === 'send' && await accepted(t, id, signal)) return snapshot(t, id, signal)
        signal.throwIfAborted()
        if (initial) {
            if ('expectedRevision' in request && JSON.parse(String(initial.record)).draft.revision !== request.expectedRevision && request.action !== 'send') throw changed()
            const updated = await db.execute({ sql: 'UPDATE desktop_foreman_voice_attempts SET epoch=?,cancelled=0 WHERE attempt_id=? AND target=? AND epoch=?', args: [epoch, id, voiceTargetJson(t), Number(initial.epoch)] })
            if (updated.rowsAffected !== 1) throw changed()
        } else if (request.action !== 'upload') throw changed()
        const storage = foremanVoiceStore(db, t, epoch)
        const guard = async () => {
            await owner(t, signal, request.action !== 'discard')
            const row = await storage.row(id)
            if (row && (Number(row.epoch) !== epoch || row.cancelled)) throw changed()
            if (!row && (await db.execute({ sql: 'SELECT 1 FROM desktop_foreman_voice_cancellations WHERE attempt_id=?', args: [id] })).rows.length) throw changed()
        }
        const service = createDesktopVoiceService({
            store: storage.store, blobs: storage.blobs,
            owner: async scope => { if (JSON.stringify(scope) !== JSON.stringify(voiceScope(t))) throw changed(); await guard() },
            transcriptionAvailable: async () => (await aux.list()).some(x => x.purpose === 'transcription' && x.configured),
            transcribe: ({ bytes, format, signal }) => backends.transcribe(bytes, format, signal),
            references: async () => { const row = await storage.row(id); return !!row?.send_requested || !!row?.accepted_run },
            send: async () => {
                await guard()
                const row = await storage.row(id)
                if (!row) throw changed()
                const draft = desktopVoiceDraftSchema.parse(JSON.parse(String(row.record)).draft), text = draft.transcript?.trim()
                if (!text) throw new DesktopHttpError(409, 'Transcribe this recording before sending.')
                await storage.blobs.read(voiceScope(t), draft.recording, signal)
                const reserved = await db.execute({ sql: 'UPDATE desktop_foreman_voice_attempts SET send_requested=1 WHERE attempt_id=? AND target=? AND epoch=? AND cancelled=0', args: [id, voiceTargetJson(t), epoch] })
                if (reserved.rowsAffected !== 1) throw changed()
                await guard()
                const receipt = await ports.send({ target: t, attemptId: id, text, signal, assertCurrent: guard })
                if (receipt.runId !== id) throw changed()
                // Acceptance survives browser cancellation before the generic sent-state CAS.
                await db.execute({ sql: 'UPDATE desktop_foreman_voice_attempts SET accepted_run=? WHERE attempt_id=? AND target=?', args: [id, id, voiceTargetJson(t)] })
                return { messageId: null }
            },
        })
        const scope = voiceScope(t)
        if (request.action === 'upload') {
            if (request.durationMs < FOREMAN_VOICE_MIN_MS) throw new DesktopHttpError(400, "Couldn't hear anything in that recording.")
            const bytes = Buffer.from(request.audioBase64, 'base64')
            if (bytes.toString('base64') !== request.audioBase64) throw new DesktopHttpError(400, 'Voice upload is not canonical audio bytes.')
            await service.upload(scope, { ...scope, attemptId: id, format: request.format, durationMs: request.durationMs, levels: request.levels }, bytes, signal)
        } else {
            if (!('expectedRevision' in request)) throw changed()
            const action = { ...scope, attemptId: id, expectedRevision: request.expectedRevision }
            if (request.action === 'transcribe') await service.transcribe(scope, action, signal)
            else if (request.action === 'send') await service.send(scope, action, signal)
            else await service.discard(scope, action, signal)
        }
        await guard()
        return snapshot(t, id, signal)
    }
    return {
        handle(raw: ForemanVoiceRequest, signal: AbortSignal) {
            const request = foremanVoiceRequestSchema.parse(raw), key = keyOf(request.target, request.attemptId)
            const mutating = !['read', 'cancel'].includes(request.action)
            if (mutating && active.has(key)) return Promise.reject(new DesktopHttpError(409, 'This voice attempt is still processing. Read its current receipt.'))
            const entry = { target: request.target, controller: new AbortController(), work: undefined as Promise<unknown> | undefined }
            if (mutating) active.set(key, entry)
            const work = perform(request, AbortSignal.any([signal, entry.controller.signal]))
            entry.work = work; jobs.add(work)
            void work.finally(() => { jobs.delete(work); if (active.get(key) === entry) active.delete(key) }).catch(() => {})
            return work
        },
        read: snapshot,
        assertAdmission: (turn: ForemanTurn, signal: AbortSignal) => assertForemanVoiceAdmission(db, turn, async t => {
            await owner(t, signal)
            if ((await ownedForemanChat(db, t.chat)).sessionId !== turn.sessionId) throw changed()
        }),
        async cancelChat(chat: ForemanVoiceTarget['chat']) {
            if (chat.workspaceId !== String(runtime.workspaceId)) throw changed()
            await ownedForemanChat(db, chat)
            const targets = new Map<string, ForemanVoiceTarget>()
            for (const [key, entry] of active) if (entry.target.chat.workspaceId === chat.workspaceId && entry.target.chat.chatId === chat.chatId) {
                entry.controller.abort(); targets.set(JSON.parse(key)[1], entry.target)
            }
            const rows = await db.execute({ sql: 'SELECT attempt_id,target FROM desktop_foreman_voice_attempts WHERE chat_id=?', args: [chat.chatId] })
            for (const row of rows.rows) {
                const tuple = JSON.parse(String(row.target))
                targets.set(String(row.attempt_id), { chat, model: { connectionId: tuple[2], model: tuple[3] } })
            }
            for (const [id, target] of targets) await cancelAttempt(target, id)
        },
        async audio(target: ForemanVoiceTarget, id: string, signal: AbortSignal) {
            await owner(target, signal, false)
            const storage = foremanVoiceStore(db, target), row = await storage.row(id)
            if (!row) throw changed()
            const draft = desktopVoiceDraftSchema.parse(JSON.parse(String(row.record)).draft)
            const bytes = await storage.blobs.read(voiceScope(target), draft.recording, signal)
            await owner(target, signal, false)
            return { bytes, mimeType: draft.recording.mimeType }
        },
        async close() { lifetime.abort(); for (const entry of active.values()) entry.controller.abort(); await drain([...jobs]) },
    }
}
