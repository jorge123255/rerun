import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { foremanAlternateRequestSchema, foremanAlternateReservationSchema, foremanAlternateRunSchema, foremanModelRefSchema, foremanReplySourceSchema, type ForemanAlternateRequest, type ForemanAlternateRunRequest } from '@rerun/contracts'
import { EngineRequestError, request } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { desktopForeman } from '../foreman/binding'
import { foremanTurn, ownedForemanChat, withForemanChatWrite } from '../foreman/chat-store'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import { createForemanAlternateRepository, type AlternateInput, type AlternateProof, type AlternateReceipt } from './repository'

const refused = () => new DesktopHttpError(409, 'This saved Chief of Staff reply is no longer available for a retry.')
const sourceResponse = z.strictObject({ source: foremanReplySourceSchema.nullable() })
const alternateResponse = z.strictObject({ alternate: foremanAlternateReservationSchema.nullable() })

function engineTarget(input: AlternateInput, proof: AlternateProof): ForemanAlternateRequest {
    return foremanAlternateRequestSchema.parse({
        workspaceId: input.workspaceId, chatId: input.chatId, sessionId: proof.sourceSessionId,
        assistantMessageId: input.messageId.slice('engine-'.length), requestId: input.requestId,
        transcriptRevision: input.transcriptRevision,
    })
}

export async function bindForemanAlternates(runtime: DesktopRuntime, signal: AbortSignal) {
    const app = await desktopForeman(runtime)
    const sendEngine = async (operation: 'prepare' | 'lookup', input: AlternateInput, proof: AlternateProof) => {
        const target = engineTarget(input, proof)
        const { alternate } = await request(engineOf(runtime), '/desktop/foreman/alternate', {
            method: 'POST', body: JSON.stringify({ operation, target }), redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        }, value => alternateResponse.parse(value))
        if (!alternate) return null
        const { requestId, ...scope } = target
        if (alternate.requestId !== requestId || !isDeepStrictEqual(alternate.source, {
            ...scope, sourceRunId: proof.sourceRunId, precedingUserMessageId: proof.precedingUserId, replyDigest: proof.textDigest,
        })) throw refused()
        return { sessionId: alternate.sessionId, runId: alternate.runId, requestId, sourceSessionId: proof.sourceSessionId,
            sourceRunId: proof.sourceRunId, messageId: input.messageId, transcriptRevision: input.transcriptRevision }
    }
    const repository = createForemanAlternateRepository(app.db, {
        async access(tx, scope) {
            assertDesktopWorkspaceAdmission(runtime)
            if (scope.workspaceId !== String(runtime.workspaceId)) throw refused()
            await ownedForemanChat(tx, scope)
        },
        async target(tx, input) {
            const chat = { workspaceId: input.workspaceId, chatId: input.chatId }
            const owner = await ownedForemanChat(tx, chat)
            const expected = { ...chat, sessionId: owner.sessionId,
                assistantMessageId: input.messageId.slice('engine-'.length) }
            const query = new URLSearchParams({ ...expected, expectedTranscriptRevision: input.transcriptRevision })
            const { source } = await request(engineOf(runtime), '/desktop/foreman/reply-source?' + query, {
                cache: 'no-store', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            }, value => sourceResponse.parse(value))
            if (!source || source.transcriptRevision !== input.transcriptRevision ||
                source.workspaceId !== expected.workspaceId || source.chatId !== expected.chatId ||
                source.sessionId !== expected.sessionId || source.assistantMessageId !== expected.assistantMessageId) return null
            assertDesktopWorkspaceAdmission(runtime)
            return { workspaceId: input.workspaceId, chatId: input.chatId, sourceSessionId: source.sessionId, messageId: input.messageId,
                sourceRunId: source.sourceRunId, transcriptRevision: source.transcriptRevision, textDigest: source.replyDigest,
                precedingUserId: source.precedingUserMessageId, activeTurn: false, activeBuild: false, pendingDecision: false, completed: true }
        },
    }, {
        async fork(input, proof) {
            const result = await sendEngine('prepare', input, proof)
            if (!result) throw refused()
            return result
        },
        lookup: (input, proof) => sendEngine('lookup', input, proof),
    })
    return {
        request: (input: AlternateInput) => withForemanChatWrite(app.db, async () => {
            signal.throwIfAborted()
            const existing = (await app.db.execute({ sql: 'SELECT 1 FROM desktop_foreman_alternates WHERE request_id=?', args: [input.requestId] })).rows[0]
            if (!existing) await app.assertAlternateIdle({ workspaceId: input.workspaceId, chatId: input.chatId })
            return repository.request(input)
        }),
    }
}

async function ownedAlternateReceipt(runtime: DesktopRuntime, chat: ForemanAlternateRunRequest['chat'], requestId: string) {
    assertDesktopWorkspaceAdmission(runtime)
    if (chat.workspaceId !== String(runtime.workspaceId)) throw refused()
    const app = await desktopForeman(runtime)
    const owner = await ownedForemanChat(app.db, chat)
    const row = (await app.db.execute({
        sql: 'SELECT body FROM desktop_foreman_alternates WHERE request_id=? AND workspace_id=? AND chat_id=?',
        args: [requestId, chat.workspaceId, chat.chatId],
    })).rows[0]
    if (!row) throw refused()
    const body = String(row.body)
    const receipt = JSON.parse(body) as AlternateReceipt
    const target = engineTarget(receipt.input, receipt.proof)
    if (target.sessionId !== owner.sessionId || target.requestId !== requestId
        || target.workspaceId !== chat.workspaceId || target.chatId !== chat.chatId) throw refused()
    return { app, owner, receipt, target, body }
}

export async function changeForemanAlternateRun(runtime: DesktopRuntime, command: ForemanAlternateRunRequest, signal: AbortSignal) {
    const app = await desktopForeman(runtime)
    return withForemanChatWrite(app.db, async () => {
        signal.throwIfAborted()
        const { receipt, target, body } = await ownedAlternateReceipt(runtime, command.chat, command.requestId)
        if (receipt.state !== 'ready' || !receipt.alternate) throw refused()
        if (command.action === 'start' && receipt.runIntent === 'stop') throw refused()
        if (command.action !== 'status' && command.action !== receipt.runIntent) {
            const saved = await app.db.execute({
                sql: 'UPDATE desktop_foreman_alternates SET body=? WHERE request_id=? AND body=?',
                args: [JSON.stringify({ ...receipt, runIntent: command.action }), command.requestId, body],
            })
            if (saved.rowsAffected !== 1) throw refused()
        }
        try {
            const result = await request(engineOf(runtime), '/desktop/foreman/alternate/run', {
                method: 'POST', body: JSON.stringify({ action: command.action, target }), redirect: 'error',
                signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
            }, value => foremanAlternateRunSchema.parse(value))
            if (result.sessionId !== receipt.alternate.sessionId || result.runId !== receipt.alternate.runId) throw refused()
            return { requestId: command.requestId, status: result.status }
        } catch (error) {
            if (error instanceof EngineRequestError && error.status === 409) throw refused()
            if (error instanceof DesktopHttpError) throw error
            throw new DesktopHttpError(503, 'The retry status could not be confirmed. Check this same retry before starting another.')
        }
    })
}

// The engine callback must not reacquire the chat lock held by the app's request.
export async function authorizeForemanAlternate(runtime: DesktopRuntime, operation: 'prepare' | 'lookup' | 'start' | 'stop', target: ForemanAlternateRequest) {
    const { app, owner, receipt, target: owned } = await ownedAlternateReceipt(runtime,
        { workspaceId: target.workspaceId, chatId: target.chatId }, target.requestId)
    if (!isDeepStrictEqual(owned, target)) throw refused()
    if (operation === 'prepare') {
        if (receipt.state !== 'reserved') throw refused()
        await app.assertAlternateIdle(owner.chat)
    }
    if (operation === 'start' || operation === 'stop') {
        if (receipt.state !== 'ready' || !receipt.alternate || receipt.runIntent !== operation) throw refused()
        const { sessionId, runId } = receipt.alternate
        if (operation === 'stop') return { sessionId, runId }
        await app.assertAlternateIdle(owner.chat)
        const run = await foremanTurn(app.db, receipt.proof.sourceRunId)
        if (!run || !['admitted', 'finished'].includes(run.status) || run.body.binding.runId !== receipt.proof.sourceRunId
            || run.body.sessionId !== owner.sessionId || run.body.binding.workspaceId !== owner.chat.workspaceId
            || run.body.binding.chatId !== owner.chat.chatId) throw refused()
        assertDesktopWorkspaceAdmission(runtime)
        return { sessionId, runId, model: foremanModelRefSchema.parse(run.body.binding.model) }
    }
    assertDesktopWorkspaceAdmission(runtime)
    return { ok: true as const }
}
