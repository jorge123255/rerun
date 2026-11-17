import type { MacReplyFrame } from '@rerun/mac-pairing-client'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { randomUUID } from 'expo-crypto'

import type { ChatLink } from '@/chat/transport'

import type { MacClient } from './client'
import type { MacHub } from './hub'

export type MacSendProblem = 'sendOff' | 'busy' | 'coworkerOff' | 'removed' | 'unreachable'

// What the Mac answers a send it turns down, as the sentence the chat shows.
export function sendProblemOf(error: unknown): MacSendProblem {
    const { status, message } = error as { status?: number; message?: string }
    if (status === 403 && message === 'send_not_allowed') return 'sendOff'
    if (status === 403) return 'coworkerOff'
    if (status === 409) return 'busy'
    if (status === 401) return 'removed'
    return 'unreachable'
}

type Turn = { agentId: string; chatId: string; requestId: string }

const REPLY_PART = 'reply'
// Between two looks at a turn the Mac no longer streams (its stream closes after a minute).
const POLL_MS = 1500

const pause = (ms: number, signal?: AbortSignal) =>
    new Promise<void>(resolve => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })

// The Mac streams the text of the reply to the turn the phone started. Each time the phone attaches,
// the Mac plays the reply again from its start: what is already on screen is skipped, so the text
// only ever grows. The saved chat, read once the stream ends, is what stays on screen.
export function replyStream(client: MacClient, hub: MacHub, turn: Turn, { messageId, signal }: { messageId?: string; signal?: AbortSignal }): ReadableStream<UIMessageChunk> {
    return new ReadableStream<UIMessageChunk>({
        async start(controller) {
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
                while (!signal?.aborted) {
                    // A stream the Mac cuts, or cannot open, is not the end of the turn: its status says.
                    await client.streamSentTurn(turn.agentId, turn.chatId, turn.requestId, onFrame, signal).catch(() => {})
                    if (signal?.aborted) break
                    const { status } = await client.readSentTurn(turn.agentId, turn.chatId, turn.requestId, signal)
                    if (status !== 'running') break
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

    return {
        async sendMessages({ messages, abortSignal }) {
            const text = lastUserText(messages)
            const requestId = randomUUID()
            let chatId = link.sessionRef.current
            try {
                if (chatId) await client.sendMessage(agentId, chatId, { requestId, text }, abortSignal)
                else chatId = await client.startConversation(agentId, { requestId, text }, abortSignal)
            } catch (error) {
                throw new Error(describe(sendProblemOf(error)))
            }
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
                const { status } = await client.readSentTurn(agentId, chatId, requestId, abortSignal)
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
