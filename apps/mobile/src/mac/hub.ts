import { FOREMAN_AGENT_ID, type AgentConversationsOverview, type AgentModels, type AgentView, type BoardAgent, type Box, type Conversation, type ConversationMessage, type ForemanStateResponse, type Inbox, type InboxItem, type Me, type SessionStatus } from '@rerun/contracts'
import { macPhoneChatReadSchema, macPhoneChatsSchema, macPhoneChiefChatSchema, macPhoneChiefSchema, macPhoneCoworkersSchema, macPhoneInboxSchema, macPhoneVoiceSessionSchema, type MacPhoneChat, type MacPhoneChiefCard, type MacPhoneChiefChat, type MacPhoneInboxItem, type MacPhoneChatRead, type MacPhoneCoworker, type MacPhoneVoiceSession } from '@rerun/mac-contracts/mac-phone-pairing'

import type { MacClient } from './client'
import type { MacLink } from './session'
import { turnOf } from './turns'

// The app's screens ask a hub for what they show, by its `/api/v1` paths. A paired Mac is not a hub:
// its phone listener serves the coworkers of one workspace, their saved chats, its inbox and its
// Chief of Staff (the Foreman's pages here), and nothing else. This answers the paths those screens
// read with what the Mac serves, in the shapes a hub gives, so the Home and the chat run unchanged.
// What a Mac does not serve to a phone (Boxes, files, routines, voice, AI providers) answers empty
// where a screen needs an answer to draw, and "not available" everywhere else.

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
    // A voice conversation with the Chief of Staff on one of its conversations: the token for the
    // phone's own session with the voice service. It is handed straight to that session, never kept.
    startVoice: (chatId: string, signal?: AbortSignal) => Promise<MacPhoneVoiceSession>
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
export type MacWords = { approvalOnMac: () => string; macOnly: (kind: MacOnlyKind) => string; chiefCard?: (kind: MacPhoneChiefCard['kind']) => string; openOnMac?: () => string }
export type MacOnlyKind = NonNullable<NonNullable<MacPhoneChatRead['pending']>['macOnly']>['kind']

const CHIEF_CARDS = { plan: 'A plan to build', 'team-changes': 'Changes to your team', starter: 'A starter pack' } as const
const ENGLISH: Required<MacWords> = { approvalOnMac: () => 'Waiting for your approval on your Mac', macOnly: () => 'Waiting for you on your Mac', chiefCard: kind => CHIEF_CARDS[kind], openOnMac: () => 'Open on your Mac to approve' }

// A card of the Chief of Staff that changes things, as the text it is shown as: what it is, its
// words, and where it is settled. The phone holds nothing that could settle it.
export function chiefCardText(card: MacPhoneChiefCard, words: MacWords = ENGLISH): string {
    const lines = card.lines.filter(Boolean).map(line => `- ${line}`)
    return [`**${(words.chiefCard ?? ENGLISH.chiefCard)(card.kind)}**`, card.title, lines.join('\n'), `_${(words.openOnMac ?? ENGLISH.openOnMac)()}_`].filter(Boolean).join('\n\n')
}

// The Mac sends a saved chat as text, and what it waits on in words. A question is put back where the
// app looks for its card, a tool call left open at the end of the last reply. So is an approval, when
// the person allowed this phone to approve requests on the Mac: the card shows the action and its
// detail as the Mac's does, and nothing is decided without a tap. Otherwise the approval is shown as
// text, like the requests only the Mac settles (a held app action, a secret, a sign-in).
export function messagesOf(read: Pick<MacPhoneChatRead, 'messages' | 'pending' | 'permissions'> & { cards?: MacPhoneChiefCard[] }, words: MacWords = ENGLISH): ConversationMessage[] {
    const messages: ConversationMessage[] = read.messages.map(message => ({
        id: message.id,
        role: message.role,
        parts: [{ type: 'text', text: message.content.text }],
        ...(message.createdAt ? { metadata: { createdAt: message.createdAt } } : {}),
    }))
    // The Chief of Staff's cards that change things are words in a message of their own, after the
    // reply that showed them: the chat would run them into the end of that reply.
    const chief = read.cards ?? []
    if (chief.length > 0) messages.push({ id: `cards-${messages.at(-1)?.id ?? 'chief'}`, role: 'assistant', parts: chief.map(card => ({ type: 'text', text: chiefCardText(card, words) })) })
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

// A conversation with the Chief of Staff, read as a coworker's chat is. Its approval stays text: what
// it asks to approve is decided on the Mac, whatever this phone may approve for coworkers.
export function chiefMessagesOf(read: MacPhoneChiefChat, words: MacWords = ENGLISH): ConversationMessage[] {
    return messagesOf({ messages: read.messages, pending: read.pending, permissions: { sendMessages: read.permissions?.sendMessages === true, approveRequests: false }, cards: read.cards }, words)
}

// What the conversation's row says it is doing: a reply being written, or what it waits on.
export function chiefWaitingOf(read: MacPhoneChiefChat): SessionStatus | null {
    if (read.running) return 'working'
    if (read.pending?.question) return 'awaiting_question'
    if (read.pending?.approval) return 'awaiting_approval'
    return read.cards.length > 0 ? 'waiting_human' : null
}

const INBOX_STATUS = { question: 'awaiting_question', approval: 'awaiting_approval', 'on-mac': 'waiting_human', done: 'done' } as const

// A row of the Mac's Actions inbox, as the app's inbox lists one.
export function inboxItemOf(item: MacPhoneInboxItem): InboxItem {
    return { id: item.id, sessionId: item.sessionId, sessionIds: item.sessionIds, agentId: item.agentId, agentName: item.agentName, status: INBOX_STATUS[item.state], title: item.title, message: item.message, updatedAt: item.updatedAt, count: item.count }
}

export function waitingOf(read: MacPhoneChatRead): SessionStatus | null {
    if (read.pending?.question) return 'awaiting_question'
    if (read.pending?.approval) return 'awaiting_approval'
    return read.pending?.macOnly ? 'waiting_human' : null
}

// How long a stopped turn is given to end on the Mac before the chat is read anyway.
const STOP_SETTLE_MS = 4000
const STOP_POLL_MS = 250

type Route = { method: string; pattern: RegExp; answer: (ids: string[], request: MacHubRequest, query: URLSearchParams) => Promise<unknown> | unknown }

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
        const { status } = await ask(() => turnOf(client, { ...turn, chatId }).status(signal))
        if (status === 'running') return { runId: turn.requestId }
        if (running.get(chatId) === turn.requestId) running.delete(chatId)
        return { runId: null }
    }

    async function stop(chatId: string, signal?: AbortSignal): Promise<void> {
        const turn = turns.get(chatId)
        if (!turn) return
        const stopped = (async () => {
            const sent = turnOf(client, { ...turn, chatId })
            await ask(() => sent.stop(signal))
            for (const until = Date.now() + STOP_SETTLE_MS; Date.now() < until; ) {
                const over = await sent.status(signal).then(
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

    // The app marks rows read by their conversations, the Mac by the rows themselves: the rows last
    // listed are kept to tell which ones were meant.
    let listed: MacPhoneInboxItem[] = []

    async function inbox(signal?: AbortSignal): Promise<Inbox> {
        listed = macPhoneInboxSchema.parse(await ask(() => client.readInbox(signal))).items
        return { items: listed.map(inboxItemOf), running: running.size }
    }

    async function markInboxRead(body: unknown, signal?: AbortSignal): Promise<void> {
        const asked = body as { all?: boolean; sessionIds?: string[] }
        const sessions = new Set(asked.sessionIds ?? [])
        const ids = listed.filter(item => asked.all === true || item.sessionIds.some(id => sessions.has(id))).map(item => item.id)
        if (ids.length === 0) return
        await ask(() => client.markInboxRead(ids, signal))
        listed = listed.filter(item => !ids.includes(item.id))
    }

    // The Chief of Staff. While it still asks its first-run company questions the Mac serves nothing
    // of it: the page says to finish there, and lists no conversation.
    async function chief(signal?: AbortSignal) {
        return macPhoneChiefSchema.parse(await ask(() => client.readChief(signal)))
    }

    async function chiefConversations(signal?: AbortSignal): Promise<Conversation[]> {
        await Promise.allSettled([...reads])
        const { conversations } = await chief(signal)
        return conversations.map(chat => conversationOf({ ...chat, agentId: FOREMAN_AGENT_ID, title: chat.title ?? '' }, statusOf(chat.id)))
    }

    // The phase stays `companion` whatever the Mac says: an onboarding phase would send the whole app
    // into the hub's own first-run questions, which a paired Mac never serves. The Chief of Staff's page
    // reads `onboarding` on the surface and says to finish on the Mac.
    async function chiefState(signal?: AbortSignal): Promise<ForemanStateResponse> {
        const { state } = await chief(signal)
        return { surface: state === 'intake' ? 'onboarding' : 'engine', phase: 'companion', firstName: '' }
    }

    async function readChiefChat(chatId: string, signal?: AbortSignal): Promise<MacPhoneChiefChat> {
        await stops.get(chatId)
        const read = macPhoneChiefChatSchema.parse(await ask(() => client.openChiefChat(chatId, signal)))
        agentOfChat.set(chatId, FOREMAN_AGENT_ID)
        waiting.set(chatId, chiefWaitingOf(read))
        if (read.pending?.question) questions.set(chatId, read.pending.question)
        else questions.delete(chatId)
        return read
    }

    const chiefRun = async (chatId: string, signal?: AbortSignal) => (await activeRun(chatId, signal).catch(() => ({ runId: null }))).runId

    // With a conversation named, its messages and the turn this phone has going in it. Without, what
    // the Home's row says: the conversation last written in, General or a task.
    async function chiefConversation(chatId: string | null, signal?: AbortSignal) {
        if (chatId) return { sessionId: chatId, messages: chiefMessagesOf(await tracked(readChiefChat(chatId, signal)), words), activeRunId: await chiefRun(chatId, signal) }
        const { conversations } = await chief(signal)
        const last = [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
        return last ? { sessionId: last.id, title: last.title, messages: [], activeRunId: await chiefRun(last.id, signal) } : null
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
        { method: 'GET', pattern: /^\/api\/v1\/inbox$/, answer: (_, { signal }) => inbox(signal) },
        { method: 'POST', pattern: /^\/api\/v1\/inbox\/read$/, answer: (_, { body, signal }) => markInboxRead(body, signal) },
        { method: 'GET', pattern: /^\/api\/chat\/foreman\/state$/, answer: (_, { signal }) => chiefState(signal) },
        { method: 'GET', pattern: /^\/api\/chat\/foreman\/engine$/, answer: (_, { signal }, query) => chiefConversation(query.get('sessionId'), signal) },
        { method: 'DELETE', pattern: /^\/api\/chat\/foreman\/engine$/, answer: (_, { signal }, query) => stop(query.get('sessionId') ?? '', signal) },
        { method: 'GET', pattern: /^\/api\/v1\/foreman\/conversations$/, answer: (_, { signal }) => chiefConversations(signal) },
        // Attachments stay on the Mac.
        { method: 'GET', pattern: /^\/api\/v1\/foreman\/files$/, answer: () => ({ supported: false }) },
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
            const [pathname, search = ''] = path.split('?')
            for (const route of routes) {
                if (route.method !== method) continue
                const match = route.pattern.exec(pathname)
                if (match) return (await route.answer(match.slice(1).map(decodeURIComponent), request, new URLSearchParams(search))) as T
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
        startVoice: async (chatId, signal) => macPhoneVoiceSessionSchema.parse(await ask(() => client.startVoice(chatId, signal))),
    }
}
