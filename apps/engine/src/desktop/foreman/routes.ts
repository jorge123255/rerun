import { Hono } from 'hono'
import { z } from 'zod'
import { FOREMAN_AGENT_ID, foremanBindingSchema, foremanBriefSchema, foremanChatRefSchema, foremanQuestionGuardSchema } from '@rerun/contracts'
import { withAgentLock } from '../../agents/lock.js'
import { getAgent } from '../../agents/registry.js'
import { resolveRunModel } from '../../agents/availability.js'
import { getSession } from '../../db/repos/sessions.js'
import { getRun, cancelRun } from '../../db/repos/runs.js'
import { readForemanReplySource } from '../../db/repos/foreman-reply-sources.js'
import { assertDesktopRunAdmission } from '../workspace-admission.js'
import { getDesktopQueuedTurn, reserveDesktopQueuedTurn } from '../../db/repos/desktop-queued-turns.js'
import { HttpError } from '../../lib/errors.js'
import { claimSession, releaseSession, sessionClaim } from '../../runtime/run-control.js'
import { runAgent } from '../../runtime/loop.js'
import { mergeRunStream } from '../../runtime/run-stream-merge.js'
import { resumeStreamResponse, toResumableStreamResponse } from '../../runtime/stream.js'
import { assertDesktopProvider, desktopApp } from '../policy.js'
import { readDesktopForemanBinding } from './binding.js'
import { readForemanQuestion } from './question.js'
import type { createDesktopForemanBridge } from './bridge.js'
import { createForemanFilePermissionRoutes } from '../foreman-agent-files/permissions.js'
export const desktopForemanChatSchema = z.strictObject({
    binding: foremanBindingSchema.extend({ runId: z.uuid() }), sessionId: z.uuid(),
    text: z.string().min(1).max(20_000).refine(value => !!value.trim()),
    brief: foremanBriefSchema.extend({ instructions: z.string().min(1).max(12_000), tools: z.array(z.never()).max(0), hubToken: z.never().optional() }).strict(),
    replayOnly: z.boolean().optional(),
    question: foremanQuestionGuardSchema.optional(),
})
function isOwnedForemanSession(session: NonNullable<Awaited<ReturnType<typeof getSession>>>) {
    return session.agentId === FOREMAN_AGENT_ID && session.source === 'dashboard'
        && session.status === 'open' && !session.originAgentId && !session.originSessionId
}
function sameQuestion(left: z.infer<typeof foremanQuestionGuardSchema>, right: z.infer<typeof foremanQuestionGuardSchema>) {
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
            return c.json({ question: await readForemanQuestion(session.id) })
        } catch (error) {
            return c.json({ error: 'The Foreman question could not be read.' }, error instanceof HttpError && error.status === 409 ? 409 : 503)
        }
    })
    routes.get('/reply-source', async c => {
        const bridge = readBinding()
        if (!desktopApp() || !bridge) return c.json({ error: 'Desktop Foreman is unavailable.' }, 404)
        const target = foremanChatRefSchema.extend({
            sessionId: z.uuid(),
            assistantMessageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
            expectedTranscriptRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        }).safeParse(c.req.query())
        if (!target.success) return c.json({ error: 'Invalid saved Foreman reply.' }, 400)
        const { expectedTranscriptRevision, ...scope } = target.data
        const source = scope.workspaceId === bridge.workspaceId ? await readForemanReplySource(scope) : null
        const sameTranscript = expectedTranscriptRevision === undefined || source?.transcriptRevision === expectedTranscriptRevision
        return c.json({ source: readBinding() === bridge && sameTranscript ? source : null }, 200, { 'cache-control': 'no-store' })
    })
    routes.post('/chat', async c => {
        try {
            if (!desktopApp()) throw new HttpError(404, 'Desktop Foreman is unavailable.')
            const raw = await c.req.text()
            if (Buffer.byteLength(raw) > 48 * 1024) throw new HttpError(413, 'Foreman message exceeds limit.')
            const body = desktopForemanChatSchema.parse(JSON.parse(raw)), signal = c.req.raw.signal
            const turn = { runId: body.binding.runId, sessionId: body.sessionId, message: body.text, foreman: { binding: body.binding, brief: body.brief, ...(body.question && { question: body.question }) } }
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
                if (sessionClaim(body.sessionId)) throw new HttpError(409, 'Wait for the Foreman’s current reply to finish.')
                await bridge.admit(exact, signal)
                signal.throwIfAborted()
                if (readBinding() !== bridge) throw new HttpError(409, 'Foreman app launch changed.')
                const holder = claimSession(body.sessionId, body.binding.runId)
                if (holder) throw new HttpError(409, 'The Foreman is already replying in this conversation.')
                try {
                    const question = session ? await readForemanQuestion(session.id) : null
                    if (body.question ? !question || !sameQuestion(body.question, question.guard) : question) {
                        throw new HttpError(409, body.question ? 'This Foreman question has changed.' : 'Answer or dismiss the Foreman question before sending another message.')
                    }
                    signal.throwIfAborted()
                    assertDesktopRunAdmission()
                    const queuedUser = await reserveDesktopQueuedTurn(FOREMAN_AGENT_ID, turn, undefined, undefined, undefined, !session)
                    const view = { ...agent, brief: body.brief }
                    return identified(toResumableStreamResponse(turn.runId, async writer => {
                        try {
                            await bridge.admit(exact, signal)
                            signal.throwIfAborted()
                            assertDesktopRunAdmission()
                            if (readBinding() !== bridge) throw new HttpError(409, 'Foreman app launch changed.')
                            const result = await runAgent(view, turn.sessionId, turn.message, override, writer, turn.runId, { source: 'chat', queuedUser }); mergeRunStream(writer, result, { provider: model.provider, model: model.model }) }
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
