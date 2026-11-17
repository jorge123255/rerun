import { FOREMAN_AGENT_ID, parseHitlReply } from '@rerun/contracts'
import type { MacReplyFrame } from '@rerun/mac-pairing-client'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { randomUUID } from 'expo-crypto'

import type { ChatLink } from '@/chat/transport'

import type { MacClient } from './client'
import type { MacHub } from './hub'
import { turnOf, type MacTurn } from './turns'

export type MacSendProblem = 'sendOff' | 'approveOff' | 'busy' | 'chiefBusy' | 'coworkerOff' | 'removed' | 'unreachable' | 'answerFirst'

type Decision = { decision: 'approved' } | { decision: 'declined'; note?: string }

// The approval card sends its decisions written out as a message, the hub's protocol. The Mac records
// decisions against the approval it saved: they are read back out of that text, one for each action
// the card shows and in its order. Null for anything else, which is never passed off as a decision.
export function decisionsOf(text: string, actions: readonly { action: string }[]): Decision[] | null {
    const reply = parseHitlReply(text)
    if (reply?.kind !== 'approval' || reply.decisions.length !== actions.length) return null
    const flat = (value: string) => value.replace(/\s+/g, ' ').trim()
    if (!reply.decisions.every((item, index) => flat(item.action) === flat(actions[index].action))) return null
    return reply.decisions.map(item => (item.decision === 'approved' ? { decision: 'approved' } : { decision: 'declined', ...(item.note ? { note: item.note } : {}) }))
}

// What the question card sends is the answer written out as a message, the hub's protocol. The Mac
// records an answer against the question it saved, so the choices are read back out of that text:
// one list per question, in the card's order, or nothing at all when the person dismissed it. Null
// for anything else typed while a question waits, which the Mac would turn down.
export function answerOf(text: string, questionCount: number): { answers?: string[][] } | null {
    const reply = parseHitlReply(text)
    if (reply?.kind === 'cancelled' && reply.of === 'question') return {}
    if (reply?.kind !== 'question' || reply.answers.length !== questionCount) return null
    return { answers: reply.answers.map(item => item.answers) }
}

// What the Mac answers a send it turns down, as the sentence the chat shows.
export function sendProblemOf(error: unknown, chief = false): MacSendProblem {
    const { status, message } = error as { status?: number; message?: string }
    if (status === 403 && message === 'send_not_allowed') return 'sendOff'
    if (status === 403 && message === 'approve_not_allowed') return 'approveOff'
    // The Chief of Staff takes one message at a time, and none while something waits on the Mac.
    if (chief && (status === 403 || status === 409)) return 'chiefBusy'
    if (status === 403) return 'coworkerOff'
    if (status === 409) return 'busy'
    if (status === 401) return 'removed'
    return 'unreachable'
}

type Turn = MacTurn

const REPLY_PART = 'reply'
// Between two looks at a turn the Mac no longer streams (its stream closes after a minute).
const POLL_MS = process.env.NODE_ENV === 'test' ? 1 : 1500
// A Mac busy running the model can be slow to say how a turn stands, or miss once: the reply is only
// given up after this many answers in a row went missing.
const MAX_MISSES = 6

// The Mac said no, in so many words: asking again will not change it.
const isRefusal = (error: unknown) => [401, 403, 404].includes((error as { status?: number }).status ?? 0)

const pause = (ms: number, signal?: AbortSignal) =>
    new Promise<void>(resolve => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })

// The Mac streams the text of the reply to the turn the phone started. Each time the phone attaches,
// the Mac plays the reply again from its start: what is already on screen is skipped, so the text
// only ever grows. The saved chat, read once the stream ends, is what stays on screen.
export function replyStream(client: MacClient, hub: MacHub, turn: Turn, { messageId, signal }: { messageId?: string; signal?: AbortSignal }): ReadableStream<UIMessageChunk> {
    const sent = turnOf(client, turn)
    // The chat lets go of the stream when the person stops the reply: what the Mac still sends after
    // that, and the stream's own ending, go nowhere.
    let released = false
    return new ReadableStream<UIMessageChunk>({
        cancel() {
            released = true
        },
        async start(stream) {
            const controller = {
                enqueue(chunk: UIMessageChunk) {
                    if (!released) stream.enqueue(chunk)
                },
                close() {
                    if (released) return
                    released = true
                    stream.close()
                },
                error(error: unknown) {
                    if (released) return
                    released = true
                    stream.error(error)
                },
            }
            let shown = 0
            let replayed = 0
            let open = false
            const onFrame = (frame: MacReplyFrame) => {
                if ('reset' in frame) {
                    replayed = 0
                    return
                }
                const before = replayed
                replayed += frame.delta.length
                if (replayed <= shown) return
                const fresh = frame.delta.slice(Math.max(0, shown - before))
                shown = replayed
                if (!open) controller.enqueue({ type: 'text-start', id: REPLY_PART })
                open = true
                controller.enqueue({ type: 'text-delta', id: REPLY_PART, delta: fresh })
            }
            controller.enqueue(messageId ? { type: 'start', messageId } : { type: 'start' })
            try {
                let misses = 0
                while (!signal?.aborted && !released) {
                    // A stream the Mac cuts, or cannot open, is not the end of the turn: its status says.
                    await sent.stream(onFrame, signal).catch(() => {})
                    if (signal?.aborted) break
                    try {
                        const { status } = await sent.status(signal)
                        if (status !== 'running') break
                        misses = 0
                    } catch (error) {
                        if (signal?.aborted) break
                        if (isRefusal(error) || ++misses >= MAX_MISSES) throw error
                    }
                    await pause(POLL_MS, signal)
                }
                // Let go of by the person, the turn may still run on the Mac: the hub says when it is over.
                if (!signal?.aborted) hub.turnEnded(turn.chatId, turn.requestId)
                if (open) controller.enqueue({ type: 'text-end', id: REPLY_PART })
                controller.enqueue({ type: 'finish' })
                controller.close()
            } catch (error) {
                if (signal?.aborted) controller.close()
                else controller.error(error)
            }
        },
    })
}

// A conversation with a coworker on a paired Mac: the Mac starts the turn, with the coworker's own
// model and tools, and the phone follows it.
export function createMacChatTransport(link: ChatLink, client: MacClient, hub: MacHub, describe: (problem: MacSendProblem) => string, lastUserText: (messages: UIMessage[]) => string): ChatTransport<UIMessage> {
    const agentId = link.endpoints.agentId
    // The Chief of Staff's page: General, or a task thread that its first message starts.
    const chief = agentId === FOREMAN_AGENT_ID
    const general = chief && link.endpoints.sendBody(null, '').kind === 'general'
    // A message the Mac did not confirm is sent again under the id it first had: the Mac matches it
    // to the receipt it kept, and never starts the same message twice.
    let unconfirmed: { chatId: string | null; text: string; requestId: string } | null = null

    return {
        async sendMessages({ messages, abortSignal }) {
            const text = lastUserText(messages)
            let chatId = link.sessionRef.current
            const requestId = chief && unconfirmed?.chatId === chatId && unconfirmed.text === text ? unconfirmed.requestId : randomUUID()
            const question = chatId ? hub.waitingQuestion(chatId) : null
            const answer = question ? answerOf(text, question.questions.length) : null
            if (question && !answer) throw new Error(describe('answerFirst'))
            const approval = chatId && !question && !chief ? hub.waitingApproval(chatId) : null
            const decisions = approval ? decisionsOf(text, approval.approvals) : null
            if (approval && !decisions) throw new Error(describe('answerFirst'))
            try {
                if (chief && chatId && question && answer) await client.answerChief(chatId, { requestId, toolCallId: question.toolCallId, ...answer }, abortSignal)
                else if (chief) chatId = await client.sendToChief({ requestId, text, ...(chatId ? { chatId } : general ? {} : { thread: true }) }, abortSignal)
                else if (chatId && approval && decisions) await client.decideApproval(agentId, chatId, { requestId, toolCallId: approval.toolCallId, decisions }, abortSignal)
                else if (chatId && question && answer) await client.answerQuestion(agentId, chatId, { requestId, toolCallId: question.toolCallId, ...answer }, abortSignal)
                else if (chatId) await client.sendMessage(agentId, chatId, { requestId, text }, abortSignal)
                else chatId = await client.startConversation(agentId, { requestId, text }, abortSignal)
            } catch (error) {
                if (chief) unconfirmed = { chatId, text, requestId }
                throw new Error(describe(sendProblemOf(error, chief)))
            }
            unconfirmed = null
            hub.turnStarted(chatId, agentId, requestId)
            link.runRef.current = requestId
            if (link.sessionRef.current !== chatId) link.onSessionRef.current(chatId)
            return replyStream(client, hub, { agentId, chatId, requestId }, { signal: abortSignal })
        },

        async reconnectToStream(options) {
            const { abortSignal } = options as { abortSignal?: AbortSignal }
            const messageId = link.resumeOntoRef.current ?? undefined
            link.resumeOntoRef.current = null
            link.reconnectFailedRef.current = false
            const chatId = link.sessionRef.current
            const requestId = link.runRef.current
            if (!chatId || !requestId) return null
            try {
                const { status } = await turnOf(client, { agentId, chatId, requestId }).status(abortSignal)
                if (status !== 'running') return null
            } catch (error) {
                // No status at all: the Mac could not be reached. A refusal is an answer, the turn is not the phone's to follow.
                if (typeof (error as { status?: number }).status === 'number') return null
                if (!abortSignal?.aborted) link.reconnectFailedRef.current = true
                throw error
            }
            return replyStream(client, hub, { agentId, chatId, requestId }, { messageId, signal: abortSignal })
        },
    }
}
