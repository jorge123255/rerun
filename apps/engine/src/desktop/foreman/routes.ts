import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { DESKTOP_FOREMAN_TURN_MAX_BYTES, FOREMAN_AGENT_ID, desktopCoworkerMentionFieldsOf, documentScopeKey, desktopForemanTurnSchema, foremanAlternateRequestSchema, foremanAlternateRunActionSchema, foremanDigestSchema, foremanDocumentScope, foremanQuestionGuardSchema, foremanRequestIdentityInput, foremanReplyTargetSchema } from '@rerun/contracts'
import { withAgentLock } from '../../agents/lock.js'
import { getAgent } from '../../agents/registry.js'
import { resolveRunModel } from '../../agents/availability.js'
import { getSession } from '../../db/repos/sessions.js'
import { getRun, cancelRun } from '../../db/repos/runs.js'
import { readForemanReplySource } from '../../db/repos/foreman-reply-sources.js'
import { lookupForemanAlternate, prepareForemanAlternate } from '../../db/repos/foreman-alternate-sessions.js'
import { assertDesktopRunAdmission } from '../workspace-admission.js'
import { getDesktopQueuedTurn, reserveDesktopQueuedTurn } from '../../db/repos/desktop-queued-turns.js'
import { HttpError } from '../../lib/errors.js'
import { claimSession, releaseSession, sessionClaim } from '../../runtime/run-control.js'
import { runAgent } from '../../runtime/loop.js'
import { mergeRunStream } from '../../runtime/run-stream-merge.js'
import { resumeStreamResponse, toResumableStreamResponse } from '../../runtime/stream.js'
import { assertDesktopProvider, desktopApp } from '../policy.js'
import { readDesktopForemanBinding } from './binding.js'
import { foremanApprovalEnabled, readForemanApproval, readForemanQuestion } from './question.js'
import type { createDesktopForemanBridge } from './bridge.js'
import { createForemanFilePermissionRoutes } from '../foreman-agent-files/permissions.js'
import { runForemanAlternate } from './alternate-run.js'
import { assertImageModel, verifyImageBytes } from '../chat-images.js'
export const desktopForemanChatSchema = desktopForemanTurnSchema.safeExtend({ replayOnly: z.boolean().optional() })
function isOwnedForemanSession(session: NonNullable<Awaited<ReturnType<typeof getSession>>>) {
    return session.agentId === FOREMAN_AGENT_ID && session.source === 'dashboard'
        && session.status === 'open' && !session.originAgentId && !session.originSessionId
}
function sameRequest(left: z.infer<typeof foremanQuestionGuardSchema>, right: z.infer<typeof foremanQuestionGuardSchema>) {
    return left.runId === right.runId && left.sourceMessageId === right.sourceMessageId
        && left.toolCallId === right.toolCallId && left.digest === right.digest
}
function identified(response: Response, sessionId: string, runId: string) { response.headers.set('x-session-id', sessionId); response.headers.set('x-run-id', runId); return response }
export function createDesktopForemanRoutes(readBinding: () => ReturnType<typeof createDesktopForemanBridge> | undefined = readDesktopForemanBinding, permissionContext?: { workspaceId: string | number; launchNonce: string }) {
    const routes = new Hono()
    const permissionBinding = permissionContext ? readBinding() : undefined
    routes.route('/', createForemanFilePermissionRoutes(permissionContext, () => !!permissionBinding && readBinding() === permissionBinding && permissionBinding.workspaceId === String(permissionContext!.workspaceId)))
    routes.get('/question', async c => {
        if (!desktopApp() || !readBinding()) return c.json({ error: 'Desktop Foreman is unavailable.' }, 404)
        const sessionId = z.uuid().safeParse(c.req.query('sessionId'))
        if (!sessionId.success) return c.json({ error: 'Invalid Foreman conversation.' }, 400)
        try {
            const session = await getSession(FOREMAN_AGENT_ID, sessionId.data)
            if (!session) return c.json({ question: null })
            if (!isOwnedForemanSession(session)) throw new HttpError(409, 'Foreman conversation ownership changed.')
            const [question, approval] = await Promise.all([readForemanQuestion(session.id), readForemanApproval(session.id)])
            return c.json({ question, approval }, 200, { 'cache-control': 'no-store' })
        } catch (error) {
            return c.json({ error: 'The Foreman question could not be read.' }, error instanceof HttpError && error.status === 409 ? 409 : 503)
        }
    })
    routes.get('/reply-source', async c => {
        const bridge = readBinding()
        if (!desktopApp() || !bridge) return c.json({ error: 'Desktop Foreman is unavailable.' }, 404)
        const target = foremanReplyTargetSchema.extend({
            expectedTranscriptRevision: foremanDigestSchema.optional(),
        }).safeParse(c.req.query())
        if (!target.success) return c.json({ error: 'Invalid saved Foreman reply.' }, 400)
        const { expectedTranscriptRevision, ...scope } = target.data
        const source = scope.workspaceId === bridge.workspaceId ? await readForemanReplySource(scope) : null
        const sameTranscript = expectedTranscriptRevision === undefined || source?.transcriptRevision === expectedTranscriptRevision
        return c.json({ source: readBinding() === bridge && sameTranscript ? source : null }, 200, { 'cache-control': 'no-store' })
    })
    routes.post('/alternate', bodyLimit({ maxSize: 4096 }), async c => {
        const bridge = readBinding()
        if (!desktopApp() || !bridge) return c.json({ error: 'Desktop Foreman is unavailable.' }, 404)
        const parsed = z.strictObject({ operation: z.enum(['prepare', 'lookup']), target: foremanAlternateRequestSchema })
            .safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid alternate request.' }, 400)
        const { operation, target } = parsed.data
        const signal = c.req.raw.signal
        const assertCurrent = () => {
            signal.throwIfAborted()
            if (readBinding() !== bridge || target.workspaceId !== bridge.workspaceId) throw new HttpError(409, 'Foreman app launch changed.')
            if (operation === 'prepare') assertDesktopRunAdmission()
        }
        const authorize = async () => {
            assertCurrent()
            await bridge.authorizeAlternate(operation, target, signal)
            assertCurrent()
        }
        try {
            if (operation === 'lookup') await authorize()
            const alternate = operation === 'prepare'
                ? await prepareForemanAlternate(target, { authorize, assertCurrent })
                : await lookupForemanAlternate(target)
            assertCurrent()
            return c.json({ alternate }, 200, { 'cache-control': 'no-store' })
        } catch {
            return c.json({ error: 'The Chief of Staff alternate was not confirmed.' }, 409, { 'cache-control': 'no-store' })
        }
    })
    routes.post('/alternate/run', bodyLimit({ maxSize: 4096 }), async c => {
        const bridge = readBinding()
        if (!desktopApp() || !bridge) return c.json({ error: 'Desktop Foreman is unavailable.' }, 404)
        const input = z.strictObject({ action: foremanAlternateRunActionSchema, target: foremanAlternateRequestSchema })
            .safeParse(await c.req.json().catch(() => null))
        if (!input.success) return c.json({ error: 'Invalid alternate run request.' }, 400)
        try {
            const result = await runForemanAlternate(input.data.action, input.data.target, bridge, readBinding, c.req.raw.signal)
            return c.json(result, 200, { 'cache-control': 'no-store' })
        } catch (error) {
            const status = error instanceof HttpError ? error.status : null
            return c.json({ error: 'The Chief of Staff retry could not be confirmed.' }, status === 404 || status === 503 ? status : 409,
                { 'cache-control': 'no-store' })
        }
    })
    routes.post('/chat', bodyLimit({ maxSize: DESKTOP_FOREMAN_TURN_MAX_BYTES }), async c => {
        try {
            if (!desktopApp()) throw new HttpError(404, 'Desktop Foreman is unavailable.')
            const raw = await c.req.text()
            if (Buffer.byteLength(raw) > DESKTOP_FOREMAN_TURN_MAX_BYTES) throw new HttpError(413, 'Foreman message exceeds limit.')
            const body = desktopForemanChatSchema.parse(JSON.parse(raw)), signal = c.req.raw.signal
            const mentionFields = desktopCoworkerMentionFieldsOf(body.coworkerMentions)
            const turn = { runId: body.binding.runId, sessionId: body.sessionId, message: body.text, documents: body.documents, ...mentionFields, foreman: { binding: body.binding, brief: body.brief, ...(body.question && { question: body.question }), ...(body.approval && { approval: body.approval }) } }
            return await withAgentLock(FOREMAN_AGENT_ID, async () => {
                signal.throwIfAborted()
                const replay = await getDesktopQueuedTurn(FOREMAN_AGENT_ID, turn)
                const session = await getSession(FOREMAN_AGENT_ID, body.sessionId), run = await getRun(FOREMAN_AGENT_ID, body.binding.runId)
                if (session && !isOwnedForemanSession(session)) throw new HttpError(409, 'Foreman conversation ownership changed.')
                if (replay) {
                    if (!session || !run || run.agentId !== FOREMAN_AGENT_ID || run.sessionId !== session.id) throw new HttpError(409, 'Foreman delivery receipt ownership changed.')
                    return identified(resumeStreamResponse(run.id), session.id, run.id)
                }
                if (body.replayOnly) return Response.json({ code: 'queued_turn_not_found' }, { status: 404 })
                if (run) throw new HttpError(409, 'This Foreman message ID is already used.')
                assertDesktopRunAdmission()
                const bridge = readBinding()
                if (!bridge) throw new HttpError(503, 'The Foreman is not connected to this app launch.')
                const { replayOnly: _replay, ...exact } = body
                await bridge.admit(exact, signal)
                const agent = await getAgent(FOREMAN_AGENT_ID)
                if (agent.id !== FOREMAN_AGENT_ID || agent.config.kind !== 'foreman' || !agent.config.enabled) throw new HttpError(409, 'The managed Foreman is unavailable.')
                const override = body.binding.model, model = await resolveRunModel(agent, override)
                if (model.connection?.id !== override.connectionId || model.model !== override.model) throw new HttpError(409, 'The selected Foreman model changed.')
                assertDesktopProvider(model.provider, model.connection?.id)
                const selection = body.documents
                const questionId = body.question && createHash('sha256').update(foremanRequestIdentityInput(body.binding, body.sessionId, body.question)).digest('hex')
                const scope = foremanDocumentScope(body.binding, body.sessionId, questionId)
                const owned = (candidate: typeof scope) => documentScopeKey(candidate) === documentScopeKey(scope)
                if (selection && (!owned(selection.scope) || (questionId ? selection.modelChoice
                    : selection.modelChoice?.connectionId !== override.connectionId || selection.modelChoice.model !== override.model))) {
                    throw new HttpError(409, 'The Foreman attachment selection changed.')
                }
                const documents = selection && await bridge.documents(exact, signal)
                if (selection && (!documents || documents.length !== selection.attachmentIds.length || documents.some(({ reference }, index) =>
                    reference.attachmentId !== selection.attachmentIds[index] || !owned(reference.scope)))) {
                    throw new HttpError(409, 'The Foreman attachment selection changed.')
                }
                const images = (documents ?? []).flatMap(item => 'dataBase64' in item
                    ? [{ ...('renderedImage' in item ? item.renderedImage : item.reference), dataBase64: item.dataBase64 }] : [])
                verifyImageBytes(images)
                await assertImageModel(model.provider, FOREMAN_AGENT_ID, images.length > 0, session?.id)
                if (sessionClaim(body.sessionId)) throw new HttpError(409, 'Wait for the Foreman’s current reply to finish.')
                await bridge.admit(exact, signal)
                signal.throwIfAborted()
                if (readBinding() !== bridge) throw new HttpError(409, 'Foreman app launch changed.')
                const holder = claimSession(body.sessionId, body.binding.runId)
                if (holder) throw new HttpError(409, 'The Foreman is already replying in this conversation.')
                try {
                    const question = session ? await readForemanQuestion(session.id) : null
                    if (body.question ? !question || !sameRequest(body.question, question.guard) : question) {
                        throw new HttpError(409, body.question ? 'This Foreman question has changed.' : 'Answer or dismiss the Foreman question before sending another message.')
                    }
                    const approval = session ? await readForemanApproval(session.id) : null
                    if (body.approval ? !approval || !sameRequest(body.approval, approval.guard) : approval) {
                        throw new HttpError(409, body.approval ? 'This Foreman approval has changed.' : 'Decide the Foreman approval before sending another message.')
                    }
                    signal.throwIfAborted()
                    assertDesktopRunAdmission()
                    const queuedUser = await reserveDesktopQueuedTurn(FOREMAN_AGENT_ID, turn, undefined, undefined, undefined, !session, documents)
                    const view = { ...agent, brief: body.brief }
                    return identified(toResumableStreamResponse(turn.runId, async writer => {
                        try {
                            await bridge.admit(exact, signal)
                            signal.throwIfAborted()
                            assertDesktopRunAdmission()
                            if (readBinding() !== bridge) throw new HttpError(409, 'Foreman app launch changed.')
                            if (body.approval && !await foremanApprovalEnabled()) throw new HttpError(409, 'The Foreman approval permission was turned off.')
                            signal.throwIfAborted()
                            const result = await runAgent(view, turn.sessionId, turn.message, override, writer, turn.runId,
                                { source: 'chat', queuedUser, desktopDocuments: documents, ...mentionFields }); mergeRunStream(writer, result, { provider: model.provider, model: model.model }) }
                        catch (error) { await cancelRun(FOREMAN_AGENT_ID, turn.runId); releaseSession(turn.runId); throw error }
                    }), turn.sessionId, turn.runId)
                } catch (error) { releaseSession(turn.runId); throw error }
            })
        } catch (error) {
            return Response.json({ error: 'The Foreman message could not be accepted. Reconcile this same request before retrying.' }, { status: error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 409 })
        }
    })
    return routes
}
