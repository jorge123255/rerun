import type { AgentConversationsOverview, AgentModels, AgentView, BoardAgent, Box, Conversation, ConversationMessage, Inbox, Me, SessionStatus } from '@rerun/contracts'
import { macPhoneChatReadSchema, macPhoneChatsSchema, macPhoneCoworkersSchema, type MacPhoneChat, type MacPhoneChatRead, type MacPhoneCoworker } from '@rerun/mac-contracts/mac-phone-pairing'

import type { MacClient } from './client'
import type { MacLink } from './session'

// The app's screens ask a hub for what they show, by its `/api/v1` paths. A paired Mac is not a hub:
// its phone listener serves the coworkers of one workspace and their saved chats, and nothing else.
// This answers the paths those screens read with what the Mac serves, in the shapes a hub gives, so
// the Home and the chat run unchanged. What a Mac does not serve to a phone (the inbox, Boxes, files,
// routines, the Foreman, AI providers) answers empty where a screen needs an answer to draw, and
// "not available" everywhere else.

export type MacHubRequest = { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; signal?: AbortSignal }

type Fail = (status: number, message: string, body?: unknown) => Error

export type MacHub = {
    api: <T>(path: string, request?: MacHubRequest) => Promise<T>
    // What the chat tells the hub as it sends: which coworker a new chat belongs to, and the turn the
    // phone last started in a chat, the only one it can follow or stop.
    rememberChat: (chatId: string, agentId: string) => void
    turnStarted: (chatId: string, agentId: string, requestId: string) => void
    turnEnded: (chatId: string, requestId: string) => void
    lastTurn: (chatId: string) => { agentId: string; requestId: string } | null
    // The question a chat waits on, as last read: the Mac takes its answer as an answer, not as a message.
    waitingQuestion: (chatId: string) => NonNullable<NonNullable<MacPhoneChatRead['pending']>['question']> | null
    // The approval a chat waits on, when this phone may decide it.
    waitingApproval: (chatId: string) => NonNullable<NonNullable<MacPhoneChatRead['pending']>['approval']> | null
}

// The one Box a Mac's coworkers sit in on the Home.
export const MAC_BOX_ID = 'mac'

// The Mac says when it removed the phone, apart from a listener that is switched off for now.
export const MAC_REVOKED = 'revoked'

export const NOT_ON_A_MAC = 'This is not available on a paired Mac.'

export function macUserId(link: Pick<MacLink, 'deviceId'>): string {
    return `mac-${link.deviceId}`
}

// The person on the phone is whoever the Mac's owner approved: a member of the one workspace the
// pairing names, with no account behind it.
export function macMe(link: Pick<MacLink, 'deviceId' | 'workspaceId'>): Me {
    return {
        user: { id: macUserId(link), email: null, name: null, avatarUrl: null, locale: null },
        workspace: { id: link.workspaceId, name: null, iconUrl: null, plan: 'mac', subscribed: true, role: 'member' },
    }
}

export function boardAgentOf(coworker: MacPhoneCoworker, workspaceId: number): BoardAgent {
    const enabled = coworker.status === 'enabled'
    return {
        id: coworker.id,
        name: coworker.name,
        handle: null,
        description: null,
        templateId: null,
        status: enabled ? 'idle' : 'offline',
        workspaceId,
        spaceId: MAC_BOX_ID,
        disabledAt: enabled ? null : new Date(0).toISOString(),
        disabledReason: null,
        access: 'use',
    }
}

export function conversationOf(chat: MacPhoneChat, status: SessionStatus): Conversation {
    return {
        id: chat.id,
        agentId: chat.agentId,
        engineSessionId: chat.id,
        title: chat.title,
        status,
        source: 'dashboard',
        updatedAt: chat.updatedAt,
        originAgentId: null,
        originAgentName: null,
        kind: chat.kind,
        createdAt: chat.createdAt,
    }
}

// What the hub words for the person, in the app's language.
export type MacWords = { approvalOnMac: () => string; macOnly: (kind: MacOnlyKind) => string }
export type MacOnlyKind = NonNullable<NonNullable<MacPhoneChatRead['pending']>['macOnly']>['kind']

const ENGLISH: MacWords = { approvalOnMac: () => 'Waiting for your approval on your Mac', macOnly: () => 'Waiting for you on your Mac' }

// The Mac sends a saved chat as text, and what it waits on in words. A question is put back where the
// app looks for its card, a tool call left open at the end of the last reply. So is an approval, when
// the person allowed this phone to approve requests on the Mac: the card shows the action and its
// detail as the Mac's does, and nothing is decided without a tap. Otherwise the approval is shown as
// text, like the requests only the Mac settles (a held app action, a secret, a sign-in).
export function messagesOf(read: MacPhoneChatRead, words: MacWords = ENGLISH): ConversationMessage[] {
    const messages: ConversationMessage[] = read.messages.map(message => ({
        id: message.id,
        role: message.role,
        parts: [{ type: 'text', text: message.content.text }],
        ...(message.createdAt ? { metadata: { createdAt: message.createdAt } } : {}),
    }))
    const { question, approval, macOnly } = read.pending ?? { question: null, approval: null }
    const cards: ConversationMessage['parts'] = []
    if (approval && read.permissions?.approveRequests) cards.push({ type: 'tool-request_approval', toolCallId: approval.toolCallId, state: 'input-available', input: { approvals: approval.approvals } })
    else if (approval) cards.push({ type: 'text', text: [`**${words.approvalOnMac()}**`, ...approval.approvals.map(item => `- ${item.action}${item.detail ? `\n  ${item.detail}` : ''}`)].join('\n\n') })
    if (macOnly) cards.push({ type: 'text', text: `**${words.macOnly(macOnly.kind)}**${macOnly.summary ? `\n\n${macOnly.summary}` : ''}` })
    if (question) cards.push({ type: 'tool-ask_user', toolCallId: question.toolCallId, state: 'input-available', input: { questions: question.questions } })
    if (cards.length === 0) return messages
    const last = messages.at(-1)
    if (last?.role === 'assistant') return [...messages.slice(0, -1), { ...last, parts: [...last.parts, ...cards] }]
    return [...messages, { id: `pending-${(question ?? approval)?.toolCallId ?? 'mac'}`, role: 'assistant', parts: cards }]
}

export function waitingOf(read: MacPhoneChatRead): SessionStatus | null {
    if (read.pending?.question) return 'awaiting_question'
    if (read.pending?.approval) return 'awaiting_approval'
    return read.pending?.macOnly ? 'waiting_human' : null
}

// How long a stopped turn is given to end on the Mac before the chat is read anyway.
const STOP_SETTLE_MS = 4000
const STOP_POLL_MS = 250

type Route = { method: string; pattern: RegExp; answer: (ids: string[], request: MacHubRequest) => Promise<unknown> | unknown }

const id = '([\\w-]+)'

export function createMacHub({ client, link, fail, onRevoked, words }: { client: MacClient; link: Pick<MacLink, 'deviceId' | 'workspaceId'>; fail: Fail; onRevoked: () => void; words?: MacWords }): MacHub {
    const agentOfChat = new Map<string, string>()
    const waiting = new Map<string, SessionStatus | null>()
    const running = new Map<string, string>()
    const turns = new Map<string, { agentId: string; requestId: string }>()
    const reads = new Set<Promise<unknown>>()
    const stops = new Map<string, Promise<void>>()
    const questions = new Map<string, NonNullable<NonNullable<MacPhoneChatRead['pending']>['question']>>()
    const approvals = new Map<string, NonNullable<NonNullable<MacPhoneChatRead['pending']>['approval']>>()

    // The Mac refuses with `{ error: code }` and a status. A phone the person removed on the Mac is
    // sent back to the sign-in screen; anything else is the screen's to show.
    async function ask<T>(call: () => Promise<T>): Promise<T> {
        try {
            return await call()
        } catch (error) {
            const refusal = error as { status?: number; message?: string }
            if (typeof refusal.status !== 'number') throw error
            if (refusal.status === 401 && refusal.message === MAC_REVOKED) onRevoked()
            throw fail(refusal.status, refusal.message ?? 'request_failed', { error: refusal.message })
        }
    }

    const statusOf = (chatId: string): SessionStatus => (running.has(chatId) ? 'working' : (waiting.get(chatId) ?? 'idle'))

    async function coworkers(signal?: AbortSignal): Promise<MacPhoneCoworker[]> {
        return macPhoneCoworkersSchema.parse(await ask(() => client.listCoworkers(signal))).coworkers
    }

    async function chatsOf(agentId: string, signal?: AbortSignal): Promise<MacPhoneChat[]> {
        const { chats } = macPhoneChatsSchema.parse(await ask(() => client.listSavedChats(agentId, signal)))
        for (const chat of chats) agentOfChat.set(chat.id, agentId)
        return chats
    }

    // A hub path names a conversation alone, the Mac needs its coworker too: the lists already read
    // usually know, and every coworker's chats are read once when they do not (a chat opened from a link).
    async function agentOf(chatId: string, signal?: AbortSignal): Promise<string> {
        const known = agentOfChat.get(chatId)
        if (known) return known
        for (const coworker of await coworkers(signal)) {
            await chatsOf(coworker.id, signal).catch(() => [])
            const found = agentOfChat.get(chatId)
            if (found) return found
        }
        throw fail(404, 'not_found')
    }

    async function readChat(chatId: string, signal?: AbortSignal): Promise<MacPhoneChatRead> {
        // The chat reads itself again the moment the person stops a reply: the Mac is given the time to
        // stop the turn and save what it got to, so that read shows it.
        await stops.get(chatId)
        const agentId = await agentOf(chatId, signal)
        const read = macPhoneChatReadSchema.parse(await ask(() => client.openSavedChat(agentId, chatId, signal)))
        waiting.set(chatId, waitingOf(read))
        if (read.pending?.question) questions.set(chatId, read.pending.question)
        else questions.delete(chatId)
        if (read.pending?.approval && read.permissions?.approveRequests) approvals.set(chatId, read.pending.approval)
        else approvals.delete(chatId)
        return read
    }

    function tracked<T>(work: Promise<T>): Promise<T> {
        reads.add(work)
        const done = () => reads.delete(work)
        work.then(done, done)
        return work
    }

    async function conversationsOf(agentId: string, signal?: AbortSignal): Promise<Conversation[]> {
        // A chat being opened says what it waits on: its row is read after, so it opens on that state.
        await Promise.allSettled([...reads])
        return (await chatsOf(agentId, signal)).map(chat => conversationOf(chat, statusOf(chat.id)))
    }

    async function overview(signal?: AbortSignal): Promise<AgentConversationsOverview> {
        const list = await coworkers(signal)
        return Promise.all(
            list.map(async coworker => {
                const chats = await chatsOf(coworker.id, signal).catch(() => [])
                const latest = [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
                return { agentId: coworker.id, latest: latest ? conversationOf(latest, statusOf(latest.id)) : null, pending: chats.filter(chat => waiting.get(chat.id)).length }
            })
        )
    }

    async function agentView(agentId: string, signal?: AbortSignal): Promise<AgentView> {
        const coworker = (await coworkers(signal)).find(entry => entry.id === agentId)
        if (!coworker) throw fail(404, 'not_found')
        return { agent: boardAgentOf(coworker, link.workspaceId), detail: null, locked: false }
    }

    async function activeRun(chatId: string, signal?: AbortSignal): Promise<{ runId: string | null }> {
        const turn = turns.get(chatId)
        if (!turn) return { runId: null }
        const { status } = await ask(() => client.readSentTurn(turn.agentId, chatId, turn.requestId, signal))
        if (status === 'running') return { runId: turn.requestId }
        if (running.get(chatId) === turn.requestId) running.delete(chatId)
        return { runId: null }
    }

    async function stop(chatId: string, signal?: AbortSignal): Promise<void> {
        const turn = turns.get(chatId)
        if (!turn) return
        const stopped = (async () => {
            await ask(() => client.stopSentTurn(turn.agentId, chatId, turn.requestId, signal))
            for (const until = Date.now() + STOP_SETTLE_MS; Date.now() < until; ) {
                const over = await client.readSentTurn(turn.agentId, chatId, turn.requestId, signal).then(
                    ({ status }) => status !== 'running',
                    () => true
                )
                if (over) break
                await new Promise(resolve => setTimeout(resolve, STOP_POLL_MS))
            }
            if (running.get(chatId) === turn.requestId) running.delete(chatId)
        })()
        const settled = stopped.then(
            () => undefined,
            () => undefined
        )
        stops.set(chatId, settled)
        void settled.then(() => {
            if (stops.get(chatId) === settled) stops.delete(chatId)
        })
        await stopped
    }

    const models: AgentModels = { groups: [], pinned: null, resolved: null, boxDefault: null }
    const box: Box = { id: MAC_BOX_ID, name: 'Mac', createdAt: null, managed: false, access: 'use' }
    const nothing = () => undefined

    const routes: Route[] = [
        { method: 'GET', pattern: /^\/api\/v1\/client$/, answer: () => ({ minBuild: 0 }) },
        { method: 'GET', pattern: /^\/api\/v1\/me$/, answer: () => macMe(link) },
        { method: 'GET', pattern: /^\/api\/v1\/workspaces$/, answer: () => [macMe(link).workspace] },
        { method: 'GET', pattern: /^\/api\/v1\/members$/, answer: () => [] },
        { method: 'GET', pattern: /^\/api\/v1\/boxes$/, answer: () => [box] },
        { method: 'GET', pattern: /^\/api\/v1\/inbox$/, answer: (): Inbox => ({ items: [], running: running.size }) },
        { method: 'POST', pattern: /^\/api\/v1\/inbox\/read$/, answer: nothing },
        { method: 'GET', pattern: /^\/api\/v1\/agents$/, answer: async (_, { signal }) => (await coworkers(signal)).map(coworker => boardAgentOf(coworker, link.workspaceId)) },
        { method: 'GET', pattern: /^\/api\/v1\/agents\/conversations$/, answer: (_, { signal }) => overview(signal) },
        { method: 'GET', pattern: new RegExp(`^/api/v1/agents/${id}$`), answer: ([agentId], { signal }) => agentView(agentId, signal) },
        { method: 'GET', pattern: new RegExp(`^/api/v1/agents/${id}/models$`), answer: () => models },
        { method: 'GET', pattern: new RegExp(`^/api/v1/agents/${id}/conversations$`), answer: ([agentId], { signal }) => conversationsOf(agentId, signal) },
        { method: 'GET', pattern: new RegExp(`^/api/v1/conversations/${id}/messages$`), answer: async ([chatId], { signal }) => messagesOf(await tracked(readChat(chatId, signal)), words) },
        { method: 'GET', pattern: new RegExp(`^/api/v1/conversations/${id}/active-run$`), answer: ([chatId], { signal }) => activeRun(chatId, signal) },
        { method: 'POST', pattern: new RegExp(`^/api/v1/conversations/${id}/stop$`), answer: ([chatId], { signal }) => stop(chatId, signal) },
        { method: 'POST', pattern: new RegExp(`^/api/v1/conversations/${id}/acknowledge$`), answer: nothing },
        { method: 'GET', pattern: new RegExp(`^/api/v1/conversations/${id}/skill-proposals$`), answer: () => ({ proposals: [] }) },
        { method: 'GET', pattern: new RegExp(`^/api/v1/conversations/${id}/feedback$`), answer: () => ({ feedback: [] }) },
    ]

    return {
        async api<T>(path: string, request: MacHubRequest = {}): Promise<T> {
            const method = request.method ?? 'GET'
            const pathname = path.split('?')[0]
            for (const route of routes) {
                if (route.method !== method) continue
                const match = route.pattern.exec(pathname)
                if (match) return (await route.answer(match.slice(1).map(decodeURIComponent), request)) as T
            }
            throw fail(404, NOT_ON_A_MAC)
        },
        rememberChat: (chatId, agentId) => void agentOfChat.set(chatId, agentId),
        turnStarted(chatId, agentId, requestId) {
            agentOfChat.set(chatId, agentId)
            turns.set(chatId, { agentId, requestId })
            running.set(chatId, requestId)
            // Sending answers whatever the chat waited on.
            waiting.set(chatId, null)
            questions.delete(chatId)
            approvals.delete(chatId)
        },
        turnEnded(chatId, requestId) {
            if (running.get(chatId) === requestId) running.delete(chatId)
        },
        lastTurn: chatId => turns.get(chatId) ?? null,
        waitingQuestion: chatId => questions.get(chatId) ?? null,
        waitingApproval: chatId => approvals.get(chatId) ?? null,
    }
}
