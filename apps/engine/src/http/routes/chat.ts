import { assertDesktopRunAdmission } from '../../desktop/workspace-admission.js'
import { prepareTriggerHumanAdmission, withoutStoppedTriggerRequests } from '../../desktop/triggers/human.js'
import { desktopDocumentSendSelectionSchema, desktopResolvedDocumentsSchema, desktopStoredDocumentReferences, DESKTOP_DOCUMENT_IMAGE_MAX_FILES, DESKTOP_DOCUMENT_IMAGE_TOTAL_MAX_BYTES, desktopMcpSignInGuardSchema } from '@rerun/contracts'
import { assertDesktopMcpSignInContinuation } from '../../desktop/mcp-sign-in/admission.js'
import { readDesktopMcpSignInSource } from '../../desktop/mcp-sign-in/source.js'
import { desktopCoworkerMentionsSchema, checkedDesktopCoworkerMentions, desktopCoworkerMentionFieldsOf } from '@rerun/contracts'
import { desktopServiceRequestGuardSchema, desktopTakeoverGuardSchema, findDesktopTakeover } from '@rerun/contracts'
import { createHash } from 'node:crypto'
import { chatRequestSchema, desktopApprovalGuardSchema, desktopQuestionGuardSchema, desktopAttachmentSelectionsOf, desktopAttachmentFieldsOf, desktopAttachmentItemsSchema, hasOneDesktopAttachmentField, desktopResolvedAttachmentsSchema, desktopResolvedAttachmentSelections, desktopStoredAttachmentSelections, desktopAttachmentPathsSchema, desktopWorkspaceAttachmentSchema, desktopWorkspaceAttachmentsSchema, findDesktopApproval, findDesktopQuestion, type SessionSource } from '@rerun/contracts'
import { Hono } from 'hono'
import { z } from 'zod'
import { desktopApp } from '../../desktop/policy.js'
import { decideDesktopServiceRequestTurn } from '../../desktop/service-requests/admission.js'
import { desktopSecretRequestGuardSchema, findDesktopSecretRequest, parseDesktopSecretReceiptSummary } from '@rerun/contracts'
import { readDesktopSecretSource } from '../../desktop/secret-requests/source.js'
import { hasDesktopToolGrant } from '../../desktop/tool-grants.js'
import { resolveRunModel } from '../../agents/availability.js'
import { getAgent } from '../../agents/registry.js'
import { claimInstallSession } from '../../agents/setup.js'
import { createSession, getSession } from '../../db/repos/sessions.js'
import { extractText, listMessages, storedContent } from '../../db/repos/messages.js'
import { forkReply, getRegeneration } from '../../db/repos/regenerations.js'
import { getDesktopTabRun, startDesktopTabRun } from '../../db/repos/desktop-tab-runs.js'
import { getDesktopQueuedTurn, reserveDesktopQueuedTurn } from '../../db/repos/desktop-queued-turns.js'
import { getRun, startRun } from '../../db/repos/runs.js'
import { withAgentLock } from '../../agents/lock.js'
import { agentDisabled, HttpError } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import type { LoadedAgent } from '../../agents/types.js'
import type { ModelOverride } from '../../agents/providers.js'
import { runAgent, type RunTrigger } from '../../runtime/loop.js'
import { claimSession, releaseSession, sessionClaim } from '../../runtime/run-control.js'
import { mergeRunStream } from '../../runtime/run-stream-merge.js'
import { resumeStreamResponse, toResumableStreamResponse } from '../../runtime/stream.js'

export const chatRoutes = new Hono()
chatRoutes.use('*', async (c, next) => { if (c.req.method === 'POST') assertDesktopRunAdmission(); await next() })
const takeoverPendingMessage = 'Open and finish or skip the coworker’s browser request before sending another message.'
const questionPendingMessage = 'Answer or dismiss the coworker’s questions before sending another message.'
const approvalPendingMessage = 'Approve or decline the coworker’s proposed actions before sending another message.'
const desktopFirstTurn = z.object({ sessionId: z.uuid(), runId: z.uuid() }).strict()
const desktopQueuedTurn = z.object({ runId: z.uuid(), documents: desktopDocumentSendSelectionSchema.optional(), mcpSignIn: desktopMcpSignInGuardSchema.optional(), attachmentPath: z.string().min(1).max(4096).optional(), attachmentPaths: desktopAttachmentPathsSchema.optional(), attachmentItems: desktopAttachmentItemsSchema.optional(), replayOnly: z.boolean().optional(), question: desktopQuestionGuardSchema.optional(), approval: desktopApprovalGuardSchema.optional(), takeover: desktopTakeoverGuardSchema.optional(), service: desktopServiceRequestGuardSchema.optional(), secret: desktopSecretRequestGuardSchema.optional() }).strict()
    .refine(hasOneDesktopAttachmentField, 'Use one attachment field.')
    .refine(turn => [turn.question, turn.approval, turn.takeover, turn.service, turn.secret, turn.mcpSignIn].filter(Boolean).length <= 1, 'An answer can target only one pending request.')
const desktopChatRequest = chatRequestSchema.extend({
    message: z.string().max(20_000),
    coworkerMentions: desktopCoworkerMentionsSchema.optional(),
    workspaceAttachment: desktopWorkspaceAttachmentSchema.optional(),
    workspaceAttachments: desktopWorkspaceAttachmentsSchema.optional(),
    desktopAttachments: desktopResolvedAttachmentsSchema.optional(),
    desktopDocuments: desktopResolvedDocumentsSchema.optional(),
    desktopFirstTurn: desktopFirstTurn.optional(),
    desktopQueuedTurn: desktopQueuedTurn.optional(),
}).strict().refine(body => { try { checkedDesktopCoworkerMentions(body.message, body.coworkerMentions); return true } catch { return false } }, 'Coworker mention ranges changed.').refine(body => [body.workspaceAttachment, body.workspaceAttachments, body.desktopAttachments].filter(value => value !== undefined).length <= 1, 'Use one attachment field.')
.refine(body => !!body.message.trim() || !!body.workspaceAttachment || !!body.workspaceAttachments?.length || !!body.desktopAttachments?.length || !!body.desktopDocuments?.length
    // An exact read-only receipt probe deliberately carries identities without re-reading bytes.
    || !!(body.desktopQueuedTurn?.replayOnly && (desktopAttachmentSelectionsOf(body.desktopQueuedTurn).length || body.desktopQueuedTurn.documents)), 'Write a message or attach a file.')
.refine(body => (!body.desktopFirstTurn || (!body.sessionId && !body.install && !body.foreman && !body.desktopQueuedTurn && (!body.source || body.source === 'dashboard')))
    && (!body.desktopQueuedTurn || (!!body.sessionId && !body.install && !body.foreman && (!body.source || body.source === 'dashboard'))))

const regenerateRequest = chatRequestSchema.pick({ provider: true, model: true, connectionId: true, author: true }).extend({
    sessionId: z.string().min(1),
    regenerateMessageId: z.string().min(1),
    replayOnly: z.boolean().optional(),
    source: z.literal('dashboard').optional(),
    requestId: z.uuid(),
}).strict()

function verifyImageBytes(images: ReadonlyArray<{ dataBase64: string; sha256: string; byteLength: number }>) {
    if (images.length > DESKTOP_DOCUMENT_IMAGE_MAX_FILES || images.reduce((sum, image) => sum + image.byteLength, 0) > DESKTOP_DOCUMENT_IMAGE_TOTAL_MAX_BYTES) {
        throw new HttpError(413, 'Choose at most four images, up to 16 MiB in total.')
    }
    for (const image of images) {
        const bytes = Buffer.from(image.dataBase64, 'base64')
        if (bytes.byteLength !== image.byteLength || bytes.toString('base64') !== image.dataBase64 ||
            createHash('sha256').update(bytes).digest('hex') !== image.sha256) {
            throw new HttpError(400, 'The image bytes do not match the selected snapshot.')
        }
    }
}
async function assertImageModel(provider: string, agentId: string, includesImages: boolean, sessionId?: string, throughMessageId?: string) {
    if (!desktopApp() || provider === 'codex') return
    const hasImages = includesImages || (sessionId &&
        (await listMessages(agentId, sessionId, throughMessageId)).some(row => {
            if (row.role !== 'user') return false
            const content = storedContent(row.contentJson)
            return desktopStoredAttachmentSelections(content).some(item => typeof item !== 'string') ||
                desktopStoredDocumentReferences(content).some(item => item.kind === 'image')
        }))
    if (hasImages) throw new HttpError(400, 'Image attachments need a ChatGPT / Codex model. Choose one before sending.')
}

function identified(response: Response, sessionId: string, runId: string) {
    response.headers.set('x-session-id', sessionId)
    response.headers.set('x-run-id', runId)
    return response
}

function streamChat(agent: LoadedAgent, sessionId: string, runId: string, message: string, override: ModelOverride, meta: { provider: string; model: string }, trigger: RunTrigger) {
    return identified(toResumableStreamResponse(runId, async writer => {
        try {
            const run = await runAgent(agent, sessionId, message, override, writer, runId, trigger)
            mergeRunStream(writer, run, meta)
        } catch (err) {
            releaseSession(runId)
            throw err
        }
    }), sessionId, runId)
}

async function regenerateChat(agent: LoadedAgent, body: z.infer<typeof regenerateRequest>) {
    const source = await getSession(agent.id, body.sessionId)
    if (!source || source.agentId !== agent.id) throw new HttpError(404, 'Session not found for this agent')
    const replay = await getRegeneration(agent.id, body)
    if (replay) return identified(resumeStreamResponse(replay.runId), replay.sessionId, replay.runId)
    if (body.replayOnly) return Response.json({ code: 'regeneration_not_found' }, { status: 404 })

    const override = { connectionId: body.connectionId, provider: body.provider, model: body.model }
    const { provider, model } = await resolveRunModel(agent, override)
    await assertImageModel(provider, agent.id, false, source.id, body.regenerateMessageId)
    if (sessionClaim(source.id)) throw new HttpError(409, 'Wait for the current reply to finish before regenerating.')
    const fork = await forkReply(agent.id, source, body)
    if (!fork.user) return identified(resumeStreamResponse(fork.runId), fork.sessionId, fork.runId)
    claimSession(fork.sessionId, fork.runId, body.author?.id)
    return streamChat(agent, fork.sessionId, fork.runId, extractText(storedContent(fork.user.contentJson)), override, { provider, model }, {
        source: 'chat', author: body.author, savedUser: fork.user,
    })
}

async function resolveSession(agentId: string, sessionId: string | undefined, source: SessionSource) {
    if (sessionId) {
        const session = await getSession(agentId, sessionId)
        return session ?? null
    }
    return createSession(agentId, undefined, undefined, source)
}

chatRoutes.post('/chat', async c => {
    const agentId = c.req.param('id')!
    const agent = await getAgent(agentId)
    const input = await c.req.json()
    if (!agent.config.enabled) {
        // A disabled coworker cannot start work, but an exact read-only probe may still
        // reconcile an answer accepted before it was disabled and its acknowledgement lost.
        const parsed = desktopApp() ? desktopChatRequest.safeParse(input) : null
        const body = parsed?.success ? parsed.data : null
        const queued = body?.desktopQueuedTurn
        if (body?.desktopFirstTurn && await getDesktopTabRun(agentId, {
            ...body.desktopFirstTurn, message: body.message, ...desktopCoworkerMentionFieldsOf(body.coworkerMentions), author: body.author,
            attachments: body.workspaceAttachments ?? (body.workspaceAttachment ? [body.workspaceAttachment] : []), desktopAttachments: body.desktopAttachments, desktopDocuments: body.desktopDocuments,
        })) return identified(resumeStreamResponse(body.desktopFirstTurn.runId), body.desktopFirstTurn.sessionId, body.desktopFirstTurn.runId)
        if (body?.sessionId && queued?.replayOnly) {
            const session = await getSession(agentId, body.sessionId)
            if (session?.agentId === agentId && await getDesktopQueuedTurn(agentId, {
                runId: queued.runId, sessionId: session.id, message: body.message, ...desktopCoworkerMentionFieldsOf(body.coworkerMentions),
                ...desktopAttachmentFieldsOf(desktopAttachmentSelectionsOf(queued)), question: queued.question, approval: queued.approval, takeover: queued.takeover, service: queued.service, secret: queued.secret, mcpSignIn: queued.mcpSignIn, documents: queued.documents,
            })) return identified(resumeStreamResponse(queued.runId), session.id, queued.runId)
        }
        throw agentDisabled()
    }
    if (desktopApp() && input && typeof input === 'object' && 'regenerateMessageId' in input) return regenerateChat(agent, regenerateRequest.parse(input))
    const body = desktopApp() ? desktopChatRequest.parse(input) : { ...chatRequestSchema.parse(input), coworkerMentions: undefined, workspaceAttachment: undefined, workspaceAttachments: undefined, desktopAttachments: undefined, desktopDocuments: undefined, desktopFirstTurn: undefined, desktopQueuedTurn: undefined }
    const attachments = body.workspaceAttachments ?? (body.workspaceAttachment ? [body.workspaceAttachment] : [])
    const resolvedAttachments = body.desktopAttachments ?? []
    const documentImages = (body.desktopDocuments ?? []).filter(item => 'dataBase64' in item)
    if (documentImages.length && !body.desktopQueuedTurn?.question) throw new HttpError(400, 'Question images must be sent with their original question.')
    const images = [
        ...resolvedAttachments.filter(item => item.type === 'image').map(item => ({ ...item.image, dataBase64: item.dataBase64 })),
        ...documentImages.map(item => ({ ...item.reference, dataBase64: item.dataBase64 })),
    ]
    verifyImageBytes(images)
    const attachmentSelections = body.desktopAttachments ? desktopResolvedAttachmentSelections(body.desktopAttachments) : attachments.map(attachment => attachment.path)
    if (resolvedAttachments.filter(item => item.type === 'text').reduce((n, item) => n + Buffer.byteLength(item.content), 0) + attachments.reduce((n, item) => n + Buffer.byteLength(item.content), 0) + (body.desktopDocuments ?? []).reduce((n, item) => n + ('text' in item ? Buffer.byteLength(item.text) : 0), 0) > 128 * 1024) throw new HttpError(413, 'Attachments must be 128 KiB or smaller in total.')
    // One attachment keeps the original trigger field, so existing runs, tests and queued
    // receipts keep their shape. Two or more travel as the ordered array.
    const attachmentTrigger = body.desktopAttachments ? { desktopAttachments: body.desktopAttachments } : attachments.length === 1 ? { workspaceAttachment: attachments[0] } : attachments.length > 1 ? { workspaceAttachments: attachments } : {}
    const documentTrigger = body.desktopDocuments ? { desktopDocuments: body.desktopDocuments } : {}
    const runAgentView = agent.config.kind === 'foreman' && body.foreman ? { ...agent, brief: body.foreman } : agent
    const source = body.source ?? 'dashboard'
    if (body.desktopFirstTurn) return withAgentLock(agentId, async () => {
        const { sessionId, runId } = body.desktopFirstTurn!
        const turn = { sessionId, runId, message: body.message, ...desktopCoworkerMentionFieldsOf(body.coworkerMentions), attachments, desktopAttachments: body.desktopAttachments, desktopDocuments: body.desktopDocuments, author: body.author }
        if (await getDesktopTabRun(agentId, turn)) return identified(resumeStreamResponse(runId), sessionId, runId)
        // A disable/config write may have completed while this request awaited the lock.
        const currentAgent = await getAgent(agentId)
        if (!currentAgent.config.enabled) throw agentDisabled()
        const override = { connectionId: body.connectionId, provider: body.provider, model: body.model }
        const { provider, model } = await resolveRunModel(currentAgent, override)
        await assertImageModel(provider, agentId, images.length > 0)
        const holder = claimSession(sessionId, runId, body.author?.id)
        if (holder) throw new HttpError(409, 'This conversation is already starting. Retry the same first message.')
        try {
            assertDesktopRunAdmission()
            const queuedUser = await startDesktopTabRun(agentId, turn)
            if (!queuedUser) { releaseSession(runId); return identified(resumeStreamResponse(runId), sessionId, runId) }
            // The normal queued-user path enriches this row with context and never appends a
            // second user message. Failed preparation/Stop therefore still leave the input saved.
            return streamChat(currentAgent, sessionId, runId, body.message, override, { provider, model }, { source: 'chat', author: body.author, ...desktopCoworkerMentionFieldsOf(body.coworkerMentions), ...attachmentTrigger, ...documentTrigger, queuedUser })
        } catch (error) { releaseSession(runId); throw error }
    })
    if (body.desktopQueuedTurn) return withAgentLock(agentId, async () => {
        const queued = body.desktopQueuedTurn!
        const session = await getSession(agentId, body.sessionId!)
        if (!session || session.agentId !== agentId) throw new HttpError(404, 'Session not found for this agent')
        const turn = { runId: queued.runId, sessionId: session.id, message: body.message, ...desktopCoworkerMentionFieldsOf(body.coworkerMentions), ...desktopAttachmentFieldsOf(desktopAttachmentSelectionsOf(queued)), question: queued.question, approval: queued.approval, takeover: queued.takeover, service: queued.service, secret: queued.secret, mcpSignIn: queued.mcpSignIn, documents: queued.documents }
        if (await getDesktopQueuedTurn(agentId, turn)) return identified(resumeStreamResponse(turn.runId), session.id, turn.runId)
        if (await getRun(agentId, turn.runId)) throw new HttpError(409, 'This queued message ID is already in use.')
        // The bridge can reconcile a lost acknowledgement before re-reading a moved file or
        // resolving a changed model. A probe never creates a run or a user message.
        if (queued.replayOnly) return c.json({ code: 'queued_turn_not_found' }, 404)
        if (JSON.stringify(desktopAttachmentSelectionsOf(queued)) !== JSON.stringify(attachmentSelections)) throw new HttpError(400, 'The queued attachments do not match this message.')
        if (JSON.stringify(queued.documents?.attachmentIds ?? []) !== JSON.stringify((body.desktopDocuments ?? []).map(item => item.reference.attachmentId))) throw new HttpError(400, 'The document manifest does not match this message.')
        // Config changes share this lock. Recheck after replay reconciliation so a disable
        // while waiting cannot start a new reply, but an already accepted receipt still resumes.
        const currentAgent = await getAgent(agentId)
        if (!currentAgent.config.enabled) throw agentDisabled()
        const override = { connectionId: body.connectionId, provider: body.provider, model: body.model }
        const { provider, model } = await resolveRunModel(currentAgent, override)
        const holder = claimSession(session.id, turn.runId, body.author?.id)
        if (holder) return c.json({ error: 'a run is already in flight on this session', code: 'run_in_flight', runId: holder, sessionId: session.id }, 409)
        try {
            await assertImageModel(provider, agentId, images.length > 0, session.id)
            // Hold the session claim while checking the durable transcript: an ordinary chat
            // cannot append a new turn between this check and the atomic answer reservation.
            const messages = await withoutStoppedTriggerRequests(agentId, session.id, await listMessages(agentId, session.id))
            const pending = findDesktopQuestion(messages)
            const approval = findDesktopApproval(messages)
            const takeover = findDesktopTakeover(messages)
            const secret = findDesktopSecretRequest(messages)
            if (queued.secret) {
                const expected = queued.secret
                if (!secret || secret.sourceMessageId !== expected.sourceMessageId || secret.toolCallId !== expected.toolCallId || secret.fingerprint !== expected.fingerprint) throw new HttpError(409, 'This credential request is no longer waiting for a result.')
                const source = await readDesktopSecretSource(agentId, session.id, expected)
                if (!source || source.status !== 'done' || !hasDesktopToolGrant(currentAgent.config, 'requestSecret')) throw new HttpError(409, 'The credential source was stopped or its permission changed.')
                const summary = parseDesktopSecretReceiptSummary(body.message)
                if (!summary || JSON.stringify(summary.map(item => item.key)) !== JSON.stringify(secret.fields.map(item => item.key))) throw new HttpError(400, 'A credential result may contain only the requested variable names and their status.')
            } else if (secret && ['running', 'done'].includes((await readDesktopSecretSource(agentId, session.id))?.status ?? '')) {
                releaseSession(turn.runId)
                return c.json({ error: 'Finish or skip the credential form before sending another message.', code: 'secret_pending' }, 409)
            }
            if (queued.mcpSignIn) {
                if (!hasDesktopToolGrant(currentAgent.config, 'mcp')) throw new HttpError(403, 'MCP tools are turned off for this coworker.')
                await assertDesktopMcpSignInContinuation(agentId, session.id, queued.mcpSignIn, body.message, false)
            } else if (['running', 'done'].includes((await readDesktopMcpSignInSource(agentId, session.id))?.status ?? '')) throw new HttpError(409, 'Finish or skip MCP sign-in before sending another message.')
            const service = decideDesktopServiceRequestTurn({ rows: messages, queued })
            if (service.kind === 'reject' || service.kind === 'block') {
                releaseSession(turn.runId)
                return c.json({ error: service.error, code: service.code }, service.status)
            }
            if (queued.question) {
                const expected = queued.question
                if (!pending || pending.sourceMessageId !== expected.sourceMessageId || pending.toolCallId !== expected.toolCallId || pending.fingerprint !== expected.fingerprint) {
                    throw new HttpError(409, 'This question is no longer waiting for an answer. Reload the conversation.')
                }
            } else if (queued.approval) {
                const expected = queued.approval
                if (!approval || approval.sourceMessageId !== expected.sourceMessageId || approval.toolCallId !== expected.toolCallId || approval.fingerprint !== expected.fingerprint) {
                    throw new HttpError(409, 'This approval is no longer waiting for a decision. Reload the conversation.')
                }
            } else if (queued.takeover) {
                const expected = queued.takeover
                if (!takeover || takeover.sourceMessageId !== expected.sourceMessageId || takeover.toolCallId !== expected.toolCallId || takeover.fingerprint !== expected.fingerprint) throw new HttpError(409, 'This browser request is no longer waiting. Reload the conversation.')
            } else if (service.kind !== 'admit' && (pending || approval || takeover)) {
                // The panel may have read an idle snapshot just before this question was saved.
                // Its queued draft must remain unsent until the explicit answer is accepted.
                releaseSession(turn.runId)
                return c.json({ error: pending ? questionPendingMessage : approval ? approvalPendingMessage : takeoverPendingMessage, code: pending ? 'question_pending' : approval ? 'approval_pending' : 'takeover_pending' }, 409)
            }
            const triggerAdmission = await prepareTriggerHumanAdmission(agentId, turn)
            assertDesktopRunAdmission()
            const queuedUser = await reserveDesktopQueuedTurn(agentId, turn, attachments, body.author, body.desktopAttachments, false, body.desktopDocuments, triggerAdmission)
            return streamChat(currentAgent, session.id, turn.runId, body.message, override, { provider, model }, {
                source: 'chat', author: body.author, ...desktopCoworkerMentionFieldsOf(body.coworkerMentions), ...attachmentTrigger, ...documentTrigger, queuedUser,
            })
        } catch (error) {
            releaseSession(turn.runId)
            throw error
        }
    })
    const claim = body.install && !body.sessionId ? await claimInstallSession(agentId, () => createSession(agentId, undefined, undefined, source)) : null
    if (claim && 'inFlight' in claim) return c.json({ error: 'the installation is already under way in another conversation', code: 'install_in_flight', sessionId: claim.inFlight }, 409)
    const session = claim ? claim.session : await resolveSession(agentId, body.sessionId, source)
    if (!session) return c.json({ error: 'session not found for this agent' }, 404)
    const override = { connectionId: body.connectionId, provider: body.provider, model: body.model }
    // The same resolution the run makes, so the message names the pair that really ran: the
    // provider of the connection the override picked, and the model the plan lets it run.
    const { provider, model } = await resolveRunModel(agent, override)
    const meta = { provider, model }
    const runId = newId()
    const holder = claimSession(session.id, runId, body.author?.id)
    if (holder) {
        // `startedAt` lets the dashboard say how long the conversation has been busy and offer to
        // stop it, instead of showing a dead end the user cannot act on.
        const claim = sessionClaim(session.id)
        return c.json({ error: 'a run is already in flight on this session', code: 'run_in_flight', runId: holder, sessionId: session.id, startedAt: claim ? new Date(claim.claimedAt).toISOString() : null, authorId: claim?.authorId ?? null }, 409)
    }
    if (desktopApp()) {
        try {
            await assertImageModel(provider, agentId, images.length > 0, session.id)
            const messages = await withoutStoppedTriggerRequests(agentId, session.id, await listMessages(agentId, session.id))
            const question = findDesktopQuestion(messages)
            const approval = findDesktopApproval(messages)
            const takeover = findDesktopTakeover(messages)
            if (findDesktopSecretRequest(messages) && ['running', 'done'].includes((await readDesktopSecretSource(agentId, session.id))?.status ?? '')) {
                releaseSession(runId)
                return c.json({ error: 'Finish or skip the credential form before sending another message.', code: 'secret_pending' }, 409)
            }
            if (await readDesktopMcpSignInSource(agentId, session.id)) throw new HttpError(409, 'Finish or skip MCP sign-in before sending another message.')
            const service = decideDesktopServiceRequestTurn({ rows: messages })
            if (service.kind === 'block') {
                releaseSession(runId)
                return c.json({ error: service.error, code: service.code }, service.status)
            }
            if (question || approval || takeover) {
                releaseSession(runId)
                return c.json({ error: question ? questionPendingMessage : approval ? approvalPendingMessage : takeoverPendingMessage, code: question ? 'question_pending' : approval ? 'approval_pending' : 'takeover_pending' }, 409)
            }
        } catch (error) {
            releaseSession(runId)
            throw error
        }
    }
    assertDesktopRunAdmission()
    const run = await startRun(agent.id, session.id, runId).catch(err => {
        releaseSession(runId)
        throw err
    })
    return streamChat(runAgentView, session.id, run.id, body.message, override, meta, {
        source: 'chat', author: body.author, ...desktopCoworkerMentionFieldsOf(body.coworkerMentions), userLanguage: claim ? body.userLanguage : undefined, ...attachmentTrigger, ...documentTrigger,
    })
})
