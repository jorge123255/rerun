import 'server-only'
import { createHash } from 'node:crypto'
import type { Client } from '@libsql/client'
import {
    DESKTOP_TEAM_CHANGE_LIMITS, FOREMAN_AGENT_ID, LEGACY_DESKTOP_WORKSPACE_ID, desktopMcpSignInSourceResponseSchema,
    desktopSetupReplyQuestion, desktopToolInstallAttention, findDesktopApproval, findDesktopQuestion,
    findDesktopSecretRequest, findDesktopServiceRequest, findDesktopTakeover, hitlKindOf, redactHistoricalText,
    type DesktopForemanBinding, type DesktopForemanChatRef,
} from '@rerun/contracts'
import { getAgent, getSessionMessages, request } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { pendingConnectorApproval } from '../connector-approvals/store'
import { authorizeDesktopCoworkerCall, listDesktopCoworkerCallTargets } from '../coworker-calls/authority'
import { startDesktopChat } from '../engine'
import { readDesktopQuestion } from '../questions'
import { readDesktopRuntime, type DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { observeDesktopSetup, readDesktopSetupWaitingChat } from '../setup/service'
import { findDesktopAgent, findDesktopSession } from '../store'
import { readDesktopToolInstallHistory } from '../tool-install/runtime'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import { foremanTurn, ownedForemanChat } from './chat-store'

type SetupStep = { sessionId: string; revision: string; stepId: string }
type Contact = { agentId: string; engineAgentId: string; coworker: string }
type SetupObservation = {
    state: 'ready' | 'skipped' | 'needs_start' | 'needs_continue' | 'working' | 'needs_owner' | 'awaiting_reply'
    blocker?: 'question' | 'approval' | 'secret' | 'service' | 'takeover' | 'mcp' | 'connector' | 'tool-install' | 'original_chat'
    ownerSessionId?: string
    ownerQuestionId?: string
    lastMessage?: string
    step?: SetupStep
}
const changed = () => new DesktopHttpError(409, 'This guided setup step has changed. Ask the Chief of Staff to inspect it again.')
const noContact = () => new DesktopHttpError(403, 'Check the Chief of Staff’s Call coworkers permission and allowed coworkers.')
const normalName = (name: string) => name.trim().toLowerCase()

// The board row is a projection. Recheck the engine's enabled flag and identity even when
// its previous switch-off has not yet reached the board. Ephemeral delegates own no setup inbox.
async function activeTarget(runtime: DesktopRuntime, contact: Contact, signal: AbortSignal) {
    const target = await getAgent(engineOf(runtime), contact.engineAgentId, { signal })
    if (target.id !== contact.engineAgentId || target.id === FOREMAN_AGENT_ID || !target.config.enabled ||
        target.config.kind === 'foreman' || target.config.ephemeral) throw noContact()
    return contact
}

async function liveContact(runtime: DesktopRuntime, db: Client, binding: DesktopForemanBinding, coworker: string, signal: AbortSignal): Promise<Contact> {
    const run = await foremanTurn(db, binding.runId)
    if (!run || run.body.binding.chatId !== binding.chatId || run.body.binding.workspaceId !== binding.workspaceId ||
        binding.workspaceId !== String(runtime.workspaceId)) throw changed()
    const access = await authorizeDesktopCoworkerCall(runtime, db, {
        engineAgentId: FOREMAN_AGENT_ID, engineSessionId: run.body.sessionId, engineRunId: binding.runId,
    }, fetch, signal)
    if (!access.ok || access.caller.publicAgentId !== FOREMAN_AGENT_ID || access.caller.publicSessionId !== binding.chatId) throw noContact()
    const matches = access.caller.targets.filter(row => normalName(row.name) === normalName(coworker))
    if (matches.length !== 1 || !matches[0]!.callable) throw noContact()
    const row = matches[0]!
    return activeTarget(runtime, { agentId: row.publicAgentId, engineAgentId: row.engineAgentId, coworker: row.name }, signal)
}

// A reviewed card may outlive the run which proposed it. Its owned chat and grants must still exist.
async function approvedContact(runtime: DesktopRuntime, db: Client, chat: DesktopForemanChatRef, agentId: string, signal: AbortSignal): Promise<Contact> {
    if (chat.workspaceId !== String(runtime.workspaceId)) throw changed()
    await ownedForemanChat(db, chat)
    const chief = await getAgent(engineOf(runtime), FOREMAN_AGENT_ID, { signal })
    if (chief.id !== FOREMAN_AGENT_ID || chief.config.kind !== 'foreman' || !chief.config.enabled ||
        chief.config.ephemeral || chief.config.tools.desktopToolGrants?.callAgent !== true) throw noContact()
    const targets = await listDesktopCoworkerCallTargets(db, FOREMAN_AGENT_ID, true)
    if (!targets.some(target => target.agentId === agentId && target.callable)) throw noContact()
    const target = await findDesktopAgent(db, agentId)
    // Runtime owns a separate database for each workspace; its board rows retain the legacy local ID.
    if (!target?.enabled || target.workspaceId !== LEGACY_DESKTOP_WORKSPACE_ID) throw noContact()
    const current = await readDesktopRuntime()
    if (current.launchNonce !== runtime.launchNonce || current.dataRoot !== runtime.dataRoot || current.workspaceId !== runtime.workspaceId) throw changed()
    signal.throwIfAborted()
    assertDesktopWorkspaceAdmission(runtime)
    return activeTarget(runtime, { agentId, engineAgentId: target.engineAgentId, coworker: target.name }, signal)
}

// Only offer inline owner review for a single ask_user call. Other tools in the same turn
// (including older call formats or a second form) stay in the original coworker conversation.
function singleQuestionTurn(rows: Awaited<ReturnType<typeof getSessionMessages>>, toolCallId: string) {
    const start = rows.findLastIndex(row => row.role === 'user') + 1
    for (const row of rows.slice(start)) {
        if (row.role !== 'assistant' && row.role !== 'tool') continue
        try {
            if (row.toolCallsJson && JSON.parse(row.toolCallsJson)?.length !== 0) return false
            const content = JSON.parse(row.contentJson)
            if (typeof content === 'string') continue
            for (const part of Array.isArray(content) ? content : [content]) {
                if (part?.type === 'text' || part?.type === 'reasoning') continue
                if (!['tool-call', 'tool-result'].includes(part?.type) || typeof part.toolName !== 'string' ||
                    hitlKindOf(part.toolName) !== 'question' || part.toolCallId !== toolCallId) return false
            }
        } catch { return false }
    }
    return true
}

// Read only the original setup chat. An ordinary chat, an old reply, a tool result or a hidden
// part is never an invitation to answer. Keep personal decisions in their original controls.
async function observe(runtime: DesktopRuntime, db: Client, contact: Contact, signal: AbortSignal): Promise<SetupObservation> {
    const setup = await observeDesktopSetup(runtime, contact.agentId)
    if (setup.skipped) return { state: 'skipped' }
    if (!setup.pending) return { state: 'ready' }
    if (setup.canStart) return { state: 'needs_start' }
    if (!setup.sessionId) return { state: setup.canContinue ? 'needs_continue' : 'needs_owner' }
    const session = await findDesktopSession(db, setup.sessionId)
    if (!session || session.agentId !== contact.agentId) throw changed()
    const engine = engineOf(runtime)
    const rows = await getSessionMessages(engine, contact.engineAgentId, session.engineSessionId, { requireSuccess: true, signal })
    if (rows.some(row => row.sessionId !== session.engineSessionId)) throw changed()
    const owned = (blocker: NonNullable<SetupObservation['blocker']>): SetupObservation => ({ state: 'needs_owner', blocker, ownerSessionId: session.id })
    const questionCard = findDesktopQuestion(rows)
    if (findDesktopApproval(rows)) return owned('approval')
    if (findDesktopSecretRequest(rows)) return owned('secret')
    if (findDesktopTakeover(rows)) return owned('takeover')
    if (findDesktopServiceRequest(rows)) return owned('service')
    const path = '/agents/' + encodeURIComponent(contact.engineAgentId) + '/sessions/' + encodeURIComponent(session.engineSessionId) + '/mcp-sign-in-source'
    const mcp = await request(engine, path, { method: 'POST', body: '{}', signal }, value => desktopMcpSignInSourceResponseSchema.parse(value))
    if (mcp.agentId !== contact.engineAgentId || mcp.sessionId !== session.engineSessionId) throw changed()
    if (mcp.request && ['running', 'done'].includes(mcp.request.status)) return owned('mcp')
    if (await pendingConnectorApproval(db, session.engineSessionId)) return owned('connector')
    if ((await readDesktopToolInstallHistory(runtime, session.id, { signal })).some(row => desktopToolInstallAttention(row))) return owned('tool-install')
    if (questionCard) {
        const blocked = owned('question')
        const wording = JSON.stringify(questionCard.questions)
        // A personal approval or a credential typed into a question belongs in the original
        // conversation. Neither its wording nor the person's answer is shared with the Chief.
        if (!singleQuestionTurn(rows, questionCard.toolCallId) || redactHistoricalText(wording, wording.length) !== wording ||
            /\b(?:password|passcode|api[ -]?key|access token|private key|one[- ]time code|verification code|approve|authorize|sign in)\b/i.test(wording)) return blocked
        const { question } = await readDesktopQuestion(runtime, session.id, { signal, history: async target => {
            if (target.agent.id !== contact.agentId || target.agent.engineAgentId !== contact.engineAgentId ||
                target.session.id !== session.id || target.session.engineSessionId !== session.engineSessionId) throw changed()
            return rows
        } })
        return question && !question.attempt && question.messageId === questionCard.sourceMessageId && question.toolCallId === questionCard.toolCallId
            ? { ...blocked, ownerQuestionId: question.id } : blocked
    }
    const idle = await readDesktopSetupWaitingChat(runtime, contact.agentId, signal)
    if (idle?.sessionId !== session.id) return { state: 'working' }
    const last = rows.at(-1)
    const question = last && desktopSetupReplyQuestion(last)
    if (!last || !question || question.length > DESKTOP_TEAM_CHANGE_LIMITS.maxSetupQuestion ||
        redactHistoricalText(question, question.length) !== question) return owned('original_chat')
    if (/\b(?:paste|enter|share|send|provide|supply|type)\s+(?:(?:your|the|a|an|my)\s+)?(?:password|passcode|api[ -]?key|access token|private key|verification code|one[- ]time code)\b/i.test(question)) return owned('secret')
    return { state: 'awaiting_reply', lastMessage: question, step: { sessionId: session.id, revision: setup.revision,
        stepId: createHash('sha256').update(JSON.stringify([last.id, last.contentJson])).digest('hex') } }
}

export async function inspectChiefSetup(runtime: DesktopRuntime, db: Client, binding: DesktopForemanBinding, coworkerName: string, signal: AbortSignal) {
    const target = await liveContact(runtime, db, binding, coworkerName, signal)
    const view = await observe(runtime, db, target, signal)
    const confirmed = await liveContact(runtime, db, binding, coworkerName, signal)
    if (confirmed.agentId !== target.agentId || confirmed.engineAgentId !== target.engineAgentId) throw changed()
    return { agentId: target.agentId, coworker: target.coworker, ...view }
}

export async function applyChiefSetupReply(runtime: DesktopRuntime, db: Client, chat: DesktopForemanChatRef, agentId: string, reply: SetupStep & { text: string }, requestId: string, signal: AbortSignal, assertCard: () => Promise<void>) {
    signal.throwIfAborted()
    await assertCard()
    const target = await approvedContact(runtime, db, chat, agentId, signal)
    const text = reply.text.trim()
    if (!text || text.length > DESKTOP_TEAM_CHANGE_LIMITS.maxSetupReply || !/^[0-9a-f]{64}$/.test(reply.stepId) ||
        redactHistoricalText(text, text.length) !== text) throw changed()
    const assertCurrent = async () => {
        const view = await observe(runtime, db, target, signal)
        if (!view.step || view.step.sessionId !== reply.sessionId || view.step.revision !== reply.revision || view.step.stepId !== reply.stepId) throw changed()
        const current = await approvedContact(runtime, db, chat, agentId, signal)
        if (current.engineAgentId !== target.engineAgentId) throw changed()
        await assertCard()
        signal.throwIfAborted()
        assertDesktopWorkspaceAdmission(runtime)
    }
    // The canonical queued-turn path first probes for the same request/session/text/step. It
    // reuses a persisted receipt before checking whether the question is still unanswered.
    const started = await startDesktopChat(runtime, { agentId, sessionId: reply.sessionId, requestId,
        text,
    }, undefined, { chiefSetupReply: { stepId: reply.stepId, assertCurrent } })
    if (started.sessionId !== reply.sessionId || started.response.headers.get('x-run-id') !== requestId) throw changed()
    // As with the original setup kickoff, the coworker may keep working once admission returns.
    if (started.response.body) void started.response.body.pipeTo(new WritableStream({ write() {} })).catch(() => {})
    return { sessionId: started.sessionId, requestId }
}
