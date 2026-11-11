import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { foremanAlternateRequestSchema, foremanAlternateReservationSchema, foremanReplySourceSchema, type ForemanAlternateRequest } from '@rerun/contracts'
import { request } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { desktopForeman } from '../foreman/binding'
import { ownedForemanChat, withForemanChatWrite } from '../foreman/chat-store'
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

// The engine callback must not reacquire the chat lock held by the app's request.
export async function authorizeForemanAlternate(runtime: DesktopRuntime, operation: 'prepare' | 'lookup', target: ForemanAlternateRequest) {
    assertDesktopWorkspaceAdmission(runtime)
    if (target.workspaceId !== String(runtime.workspaceId)) throw refused()
    const app = await desktopForeman(runtime)
    const owner = await ownedForemanChat(app.db, { workspaceId: target.workspaceId, chatId: target.chatId })
    if (owner.sessionId !== target.sessionId) throw refused()
    const row = (await app.db.execute({
        sql: 'SELECT body FROM desktop_foreman_alternates WHERE request_id=? AND workspace_id=? AND chat_id=?',
        args: [target.requestId, target.workspaceId, target.chatId],
    })).rows[0]
    if (!row) throw refused()
    const receipt = JSON.parse(String(row.body)) as AlternateReceipt
    if (!isDeepStrictEqual(engineTarget(receipt.input, receipt.proof), target)) throw refused()
    if (operation === 'prepare') {
        if (receipt.state !== 'reserved') throw refused()
        await app.assertAlternateIdle(owner.chat)
    }
    assertDesktopWorkspaceAdmission(runtime)
}
