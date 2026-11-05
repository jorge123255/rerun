import { assertDesktopSetupChatAllowed } from './setup/service'
import type { DesktopTakeoverGuard } from '@rerun/contracts'
import 'server-only'
import { desktopChatTitle } from '../chat-content'
import { startQueuedChat } from './queued-chat'
import { DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES, desktopAttachmentFieldsOf, desktopAttachmentSelectionsOf, desktopRerunGrantsOf, type DesktopQuestionGuard, type DesktopApprovalGuard, type DesktopAttachmentItem, type DesktopResolvedAttachment } from '@rerun/contracts'
import { EngineRequestError, chat, createAgent, getAgent, getSessionMessages, patchAgent } from '@/lib/engine/client'
import type { DesktopCoworkerPatch, DesktopCoworkerSettings } from '../coworker-settings'
import { publicDesktopHistory, transformEngineMessages, type HistoryMessage } from '@/lib/chat/engine-history'
import { sanitizeIdentifier } from '@/lib/utils'
import { resolveDesktopChatModel, savedChoice } from './chat-model'
import type { DesktopModelPick } from '../chat-model'
import { changeDesktopSettings, desktopModel, engineOf, readDesktopProviders } from './settings'
import { DesktopHttpError } from './auth'
import { disabledCoworkerMessage } from './coworker-enabled'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { assertDesktopCreationSettled, desktopCreationPendingMessage } from './creation-guard'
import { readCoworkerFile } from './coworker-files'
import { readDesktopImageSnapshots } from './composer-image-files'
import { openDesktopDatabase } from './database'
import { discardTabStart, existingTabStart, recoverTabSession, reserveTabStart } from './tab-starts'
import type { DesktopRuntime } from './runtime'
import { createDesktopAgentWithinRosterWrite, createDesktopSession, findDesktopAgent, findDesktopSession, regenerationRequestId } from './store'
import { withRosterWrite } from './roster-writes'
import { planDesktopAgentPlacement } from './spaces'

// Compatibility endpoint for the original OpenAI setup form.
export async function connectDesktopOpenAI(runtime: DesktopRuntime, apiKey: string) {
    await changeDesktopSettings(runtime, { action: 'key', provider: 'openai', apiKey })
    const { connections } = await readDesktopProviders(runtime)
    const connection = connections.find(c => c.provider === 'openai')
    if (!connection) throw new DesktopHttpError(502, 'Could not read the saved connection.')
    return { id: connection.id, provider: connection.provider, name: connection.name }
}

export async function createDesktopCoworker(runtime: DesktopRuntime, input: { name: string; description?: string; spaceId?: string }) {
    const name = input.name.trim()
    if (!name || name.length > 60) throw new DesktopHttpError(400, 'Coworker name must be between 1 and 60 characters')
    const description = input.description?.trim() ?? ''
    if (description.length > 2000) throw new DesktopHttpError(400, 'Description is too long')
    const db = await openDesktopDatabase(runtime.dataRoot)
    return withRosterWrite(async () => {
        // Reject a missing/full selected Box before making an engine coworker. Keep the
        // roster lock across that call so a concurrent Box move/delete cannot orphan it.
        await planDesktopAgentPlacement(db, input.spaceId)
        const { connection } = await desktopModel(runtime)
        const handle = `${sanitizeIdentifier(name).replace(/^_+|_+$/g, '') || 'coworker'}-${crypto.randomUUID().slice(0, 8)}`
        const created = await createAgent(engineOf(runtime), {
            config: {
                name: handle,
                displayName: name,
                description,
                enabled: true,
                connectionId: connection.id,
                provider: connection.provider,
                model: null,
            },
        })
        return createDesktopAgentWithinRosterWrite(db, { engineAgentId: created.id, name, description, spaceId: input.spaceId })
    })
}

export async function desktopCoworkerSettings(runtime: DesktopRuntime, id: string, patch?: DesktopCoworkerPatch): Promise<DesktopCoworkerSettings> {
    const agent = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), id)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    // This registry contains only user-created local coworkers. Cloud template agents, whose
    // system prompts can be sealed, cannot be resolved by their engine IDs through this route.
    const engine = engineOf(runtime)
    try {
        const { memoryEnabled, autoMemory, suggestedReplies, workspaceReadEnabled, ...textSettings } = patch ?? {}
        const tools = {
            ...(workspaceReadEnabled !== undefined && { desktopToolGrants: { workspaceRead: workspaceReadEnabled } }),
            ...(memoryEnabled !== undefined && { memory: memoryEnabled }),
            ...(suggestedReplies !== undefined && { quickReplies: suggestedReplies }),
        }
        const detail = patch ? await patchAgent(engine, agent.engineAgentId, {
            ...textSettings,
            ...(Object.keys(tools).length > 0 && { tools }),
            ...(autoMemory !== undefined && { selfImprovement: { autoMemory } }),
        }) : await getAgent(engine, agent.engineAgentId)
        return {
            soul: detail.soul, verbosity: detail.config.verbosity, soulEditable: true,
            workspaceReadEnabled: desktopRerunGrantsOf(detail.config.tools).workspaceRead,
            memoryEnabled: detail.config.tools.memory,
            suggestedReplies: detail.config.tools.quickReplies,
            autoMemory: detail.config.selfImprovement.autoMemory,
            selfImprovementEnabled: detail.config.selfImprovement.enabled,
        }
    } catch (error) {
        if (error instanceof EngineRequestError && error.status === 404) throw new DesktopHttpError(404, 'Coworker not found')
        throw new DesktopHttpError(502, 'Could not reach this coworker’s settings. Try again.')
    }
}

type DesktopChatInput = { agentId: string } & (
    | { sessionId?: string; text: string; attachmentPath?: string; attachmentPaths?: string[]; attachmentItems?: DesktopAttachmentItem[]; modelChoice?: DesktopModelPick; tabUid?: string; requestId?: string; reconcileOnly?: boolean; question?: DesktopQuestionGuard; approval?: DesktopApprovalGuard; takeover?: DesktopTakeoverGuard }
    | { sessionId: string; regenerateMessageId: string; requestId: string }
)

/** Read the ordered set a send asked for, enforcing the shared total before any turn is reserved. */
async function readDesktopAttachments(runtime: DesktopRuntime, agentId: string, paths: readonly string[]) {
    const files = await Promise.all(paths.map(path => readCoworkerFile(runtime, agentId, path, 'attach')))
    const total = files.reduce((sum, file) => sum + file.size, 0)
    if (total > DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES) throw new DesktopHttpError(413, 'Attachments must be 128 KiB or smaller in total.')
    return files
}

export async function startDesktopChat(runtime: DesktopRuntime, input: DesktopChatInput, internalCreationRequestId?: string): Promise<{ response: Response; sessionId: string }> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await assertCoworkerNotDeleting(db, input.agentId)
    const kickoff = await assertDesktopCreationSettled(db, input.agentId, internalCreationRequestId)
    if (kickoff && ('regenerateMessageId' in input || input.sessionId || input.tabUid !== kickoff.requestId || input.text !== kickoff.text ||
        input.requestId || input.reconcileOnly || input.modelChoice || input.question || input.approval || input.takeover || desktopAttachmentSelectionsOf(input).length)) {
        throw new DesktopHttpError(409, desktopCreationPendingMessage)
    }
    const agent = await findDesktopAgent(db, input.agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    if (!agent.enabled) throw new DesktopHttpError(403, disabledCoworkerMessage)
    const existing = input.sessionId ? await findDesktopSession(db, input.sessionId) : null
    if (input.sessionId && (!existing || existing.agentId !== agent.id)) throw new DesktopHttpError(404, 'Conversation not found')
    await assertDesktopSetupChatAllowed(runtime, input.agentId, input.sessionId)
    const regenerate = 'regenerateMessageId' in input
    const attachmentPaths = regenerate ? [] : desktopAttachmentSelectionsOf(input)
    const attachmentFields = desktopAttachmentFieldsOf(attachmentPaths)
    const uid = !regenerate && !existing ? input.tabUid : undefined
    const previousStart = !regenerate && uid ? await existingTabStart(db, agent, uid, input) : null
    if (previousStart) {
        const id = await recoverTabSession(db, engineOf(runtime), agent, previousStart)
        if (id) return { sessionId: id, response: new Response('data: [DONE]\n\n', { headers: {
            'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', 'x-session-id': id, 'x-run-id': String(previousStart.run_id),
        } }) }
    }
    const queued = !regenerate && input.requestId ? { runId: input.requestId, ...attachmentFields, ...(input.question && { question: input.question }), ...(input.approval && { approval: input.approval }), ...(input.takeover && { takeover: input.takeover }) } : undefined
    let replay: Response | undefined
    if (queued && existing && !regenerate) {
        const probe = await chat(engineOf(runtime), agent.engineAgentId, {
            sessionId: existing.engineSessionId, message: input.text,
            desktopQueuedTurn: { ...queued, replayOnly: true }, source: 'dashboard',
        })
        if (probe.status === 404 && (await probe.clone().json().catch(() => ({}))).code === 'queued_turn_not_found') {
            if (input.reconcileOnly) throw new DesktopHttpError(404, 'This queued message has not been sent. Review it before sending.')
        } else replay = probe
    }
    // Existing chats resolve their own saved model. Only a first send carries an unsaved choice.
    const firstChoice = !regenerate && !existing ? input.modelChoice : undefined
    const { connectionId, model } = replay ? {} : await resolveDesktopChatModel(runtime, agent, existing, firstChoice)
    const images = attachmentPaths.filter((item): item is Exclude<typeof item, string> => typeof item !== 'string')
    if (!replay && images.length) {
        const { connections } = await readDesktopProviders(runtime)
        if (connections.find(connection => connection.id === connectionId)?.provider !== 'codex')
            throw new DesktopHttpError(400, 'Image attachments need a ChatGPT / Codex model. Choose one before sending.')
    }
    const files = !replay && !regenerate ? await readDesktopAttachments(runtime, agent.id,
        attachmentPaths.filter((item): item is string => typeof item === 'string')) : []
    const resolvedImages = !replay && images.length ? await readDesktopImageSnapshots(runtime, agent.id, images) : new Map<string, Uint8Array>()
    const resolved: DesktopResolvedAttachment[] = (replay ? [] : attachmentPaths).map(item => typeof item === 'string'
        ? { type: 'text', path: item, content: files.find(file => file.path === item)!.content }
        : { type: 'image', image: item, dataBase64: Buffer.from(resolvedImages.get(item.sha256)!).toString('base64') })
    const attachmentBody = images.length ? { desktopAttachments: resolved }
        : files.length === 1 ? { workspaceAttachment: { path: files[0]!.path, content: files[0]!.content } }
        : files.length > 1 ? { workspaceAttachments: files.map(file => ({ path: file.path, content: file.content })) } : {}
    const requestId = regenerate ? await regenerationRequestId(db, input.sessionId, input.regenerateMessageId, input.requestId) : undefined
    const start = !regenerate && uid ? previousStart ?? await reserveTabStart(db, agent, uid, input, runtime.launchNonce) : null
    const engineResponse = replay ?? await (queued ? startQueuedChat : chat)(engineOf(runtime), agent.engineAgentId, {
        ...(regenerate ? {
            sessionId: existing!.engineSessionId,
            regenerateMessageId: input.regenerateMessageId.slice('engine-'.length),
            requestId: requestId!,
        } : {
            sessionId: existing?.engineSessionId, message: input.text,
            ...(start && { desktopFirstTurn: { sessionId: String(start.engine_session_id), runId: String(start.run_id) } }),
            ...(queued && { desktopQueuedTurn: queued }),
            ...attachmentBody,
        }),
        connectionId,
        model,
        source: 'dashboard',
        author: { id: 'local-profile-1', name: 'Local User' },
    })
    if (regenerate && !engineResponse.ok) {
        if (engineResponse.status === 404) throw new DesktopHttpError(404, 'This reply is no longer in the selected conversation.')
        if (engineResponse.status === 409) throw new DesktopHttpError(409, 'This reply could not be regenerated. Check that the conversation is idle and the reply is complete.')
    }
    if (engineResponse.status === 400) {
        const failure = await engineResponse.clone().json().catch(() => null)
        if (typeof failure?.error === 'string' && failure.error.includes('ChatGPT / Codex')) {
            if (start) await discardTabStart(db, start)
            throw new DesktopHttpError(400, failure.error)
        }
    }
    if (start && engineResponse.status >= 400 && engineResponse.status < 500) {
        if (!await recoverTabSession(db, engineOf(runtime), agent, start)) await discardTabStart(db, start)
        if (engineResponse.status === 403) throw new DesktopHttpError(403, disabledCoworkerMessage)
        throw new DesktopHttpError(engineResponse.status, 'The engine could not start this first message. Check the coworker or model, then try again.')
    }
    if (engineResponse.status === 403) throw new DesktopHttpError(403, disabledCoworkerMessage)
    if (!regenerate && input.approval && engineResponse.status === 409) throw new DesktopHttpError(409, 'This approval request changed or the conversation is still working. Reload the conversation and retry the saved decisions.')
    if (!regenerate && input.question && engineResponse.status === 409) throw new DesktopHttpError(409, 'This question changed or the conversation is still working. Reload the conversation and retry the saved answers.')
    if (queued && engineResponse.status === 409) throw new DesktopHttpError(409, 'This conversation is still working or the queued message changed. The queued message is kept; wait for the reply or use Send now.')
    // A replay can recover the alternate even after the engine's stream has expired.
    const completedReplay = (regenerate || !!start || !!queued) && engineResponse.status === 204
    if (!engineResponse.ok || (!engineResponse.body && !completedReplay)) throw new DesktopHttpError(502, 'The engine could not start this conversation')
    const engineSessionId = engineResponse.headers.get('x-session-id')
    if (!engineSessionId) throw new DesktopHttpError(502, 'The engine did not return a conversation ID')
    if (start && (engineSessionId !== start.engine_session_id || engineResponse.headers.get('x-run-id') !== start.run_id)) throw new DesktopHttpError(502, 'The engine returned a different first turn.')
    if (queued && (engineSessionId !== existing?.engineSessionId || engineResponse.headers.get('x-run-id') !== queued.runId)) throw new DesktopHttpError(502, 'The engine returned a different queued message.')
    if (regenerate && engineSessionId === existing!.engineSessionId) throw new DesktopHttpError(502, 'The engine did not return an alternate conversation.')
    const session = regenerate
        ? await createDesktopSession(db, { agentId: agent.id, engineSessionId, title: 'Alternate · ' + existing!.title.replace(/^Alternate · /, ''), regenerationRequestId: requestId, model: savedChoice(existing) })
        : existing ?? await createDesktopSession(db, { agentId: agent.id, engineSessionId, title: desktopChatTitle(input), model: firstChoice })
    const headers = new Headers({
        'content-type': engineResponse.headers.get('content-type') ?? 'text/event-stream',
        'x-vercel-ai-ui-message-stream': engineResponse.headers.get('x-vercel-ai-ui-message-stream') ?? 'v1',
        'x-session-id': session.id,
    })
    const runId = engineResponse.headers.get('x-run-id')
    if (runId) headers.set('x-run-id', runId)
    // Transfer ownership through a reader. Rewrapping the raw fetch body leaves it unlocked;
    // Undici can cancel that body when its original Response is collected before we send it.
    const body = completedReplay ? 'data: [DONE]\n\n' : engineResponse.body!.pipeThrough(new TransformStream())
    return { response: new Response(body, { status: 200, headers }), sessionId: session.id }
}

export async function readDesktopHistory(runtime: DesktopRuntime, sessionId: string): Promise<HistoryMessage[]> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const session = await findDesktopSession(db, sessionId)
    if (!session) throw new DesktopHttpError(404, 'Conversation not found')
    const agent = await findDesktopAgent(db, session.agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    try {
        const messages = await getSessionMessages(engineOf(runtime), agent.engineAgentId, session.engineSessionId, { requireSuccess: true })
        const history = transformEngineMessages(messages, { desktopSummaries: true, preserveSourceSteps: true })
        // Only a read of this specific alternate acknowledges it. Opening the original, or an
        // older alternate while a newer request is pending, leaves the pending attempt alone.
        await db.execute({ sql: 'UPDATE desktop_regeneration_requests SET pending = 0 WHERE alternate_session_id = ? AND pending = 1', args: [session.id] })
        return publicDesktopHistory(history)
    } catch (cause) {
        if (cause instanceof EngineRequestError && cause.status === 404) throw new DesktopHttpError(404, 'Conversation not found')
        throw new DesktopHttpError(502, 'Could not load this conversation. Try again.')
    }
}
