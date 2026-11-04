import { chatRequestSchema, desktopWorkspaceAttachmentSchema, type SessionSource } from '@rerun/contracts'
import { Hono } from 'hono'
import { z } from 'zod'
import { desktopApp } from '../../desktop/policy.js'
import { resolveRunModel } from '../../agents/availability.js'
import { getAgent } from '../../agents/registry.js'
import { claimInstallSession } from '../../agents/setup.js'
import { createSession, getSession } from '../../db/repos/sessions.js'
import { extractText, storedContent } from '../../db/repos/messages.js'
import { forkReply, getRegeneration } from '../../db/repos/regenerations.js'
import { startDesktopTabRun } from '../../db/repos/desktop-tab-runs.js'
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
const desktopFirstTurn = z.object({ sessionId: z.uuid(), runId: z.uuid() }).strict()
const desktopQueuedTurn = z.object({ runId: z.uuid(), attachmentPath: z.string().min(1).max(4096).optional(), replayOnly: z.boolean().optional() }).strict()
const desktopChatRequest = chatRequestSchema.extend({
    workspaceAttachment: desktopWorkspaceAttachmentSchema.optional(),
    desktopFirstTurn: desktopFirstTurn.optional(),
    desktopQueuedTurn: desktopQueuedTurn.optional(),
}).refine(body => (!body.desktopFirstTurn || (!body.sessionId && !body.install && !body.foreman && !body.desktopQueuedTurn && (!body.source || body.source === 'dashboard')))
    && (!body.desktopQueuedTurn || (!!body.sessionId && !body.install && !body.foreman && (!body.source || body.source === 'dashboard'))))

const regenerateRequest = chatRequestSchema.pick({ provider: true, model: true, connectionId: true, author: true }).extend({
    sessionId: z.string().min(1),
    regenerateMessageId: z.string().min(1),
    source: z.literal('dashboard').optional(),
    requestId: z.uuid(),
}).strict()

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

    const override = { connectionId: body.connectionId, provider: body.provider, model: body.model }
    const { provider, model } = await resolveRunModel(agent, override)
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
    if (!agent.config.enabled) throw agentDisabled()
    const input = await c.req.json()
    if (desktopApp() && input && typeof input === 'object' && 'regenerateMessageId' in input) return regenerateChat(agent, regenerateRequest.parse(input))
    const body = desktopApp() ? desktopChatRequest.parse(input) : { ...chatRequestSchema.parse(input), workspaceAttachment: undefined, desktopFirstTurn: undefined, desktopQueuedTurn: undefined }
    const runAgentView = agent.config.kind === 'foreman' && body.foreman ? { ...agent, brief: body.foreman } : agent
    const source = body.source ?? 'dashboard'
    if (body.desktopFirstTurn) {
        const { sessionId, runId } = body.desktopFirstTurn
        const override = { connectionId: body.connectionId, provider: body.provider, model: body.model }
        const { provider, model } = await resolveRunModel(agent, override)
        const started = await startDesktopTabRun(agentId, sessionId, runId)
        if (!started) return identified(resumeStreamResponse(runId), sessionId, runId)
        claimSession(sessionId, runId, body.author?.id)
        return streamChat(agent, sessionId, runId, body.message, override, { provider, model }, { source: 'chat', author: body.author, workspaceAttachment: body.workspaceAttachment })
    }
    if (body.desktopQueuedTurn) return withAgentLock(agentId, async () => {
        const queued = body.desktopQueuedTurn!
        const session = await getSession(agentId, body.sessionId!)
        if (!session || session.agentId !== agentId) throw new HttpError(404, 'Session not found for this agent')
        const turn = { runId: queued.runId, sessionId: session.id, message: body.message, attachmentPath: queued.attachmentPath }
        if (await getDesktopQueuedTurn(agentId, turn)) return identified(resumeStreamResponse(turn.runId), session.id, turn.runId)
        if (await getRun(agentId, turn.runId)) throw new HttpError(409, 'This queued message ID is already in use.')
        // The bridge can reconcile a lost acknowledgement before re-reading a moved file or
        // resolving a changed model. A probe never creates a run or a user message.
        if (queued.replayOnly) return c.json({ code: 'queued_turn_not_found' }, 404)
        if (queued.attachmentPath !== body.workspaceAttachment?.path) throw new HttpError(400, 'The queued attachment does not match this message.')
        const override = { connectionId: body.connectionId, provider: body.provider, model: body.model }
        const { provider, model } = await resolveRunModel(agent, override)
        const holder = claimSession(session.id, turn.runId, body.author?.id)
        if (holder) return c.json({ error: 'a run is already in flight on this session', code: 'run_in_flight', runId: holder, sessionId: session.id }, 409)
        try {
            const queuedUser = await reserveDesktopQueuedTurn(agentId, turn, body.workspaceAttachment, body.author)
            return streamChat(agent, session.id, turn.runId, body.message, override, { provider, model }, {
                source: 'chat', author: body.author, workspaceAttachment: body.workspaceAttachment, queuedUser,
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
    const run = await startRun(agent.id, session.id, runId).catch(err => {
        releaseSession(runId)
        throw err
    })
    return streamChat(runAgentView, session.id, run.id, body.message, override, meta, {
        source: 'chat', author: body.author, userLanguage: claim ? body.userLanguage : undefined, workspaceAttachment: body.workspaceAttachment,
    })
})
