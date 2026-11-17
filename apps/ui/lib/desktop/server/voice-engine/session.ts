import type { DesktopForemanChatRef } from '@rerun/contracts'
import { createVoiceConversation, type VoiceChief } from './conversation'
import { upstreamMessageSchema, type DownstreamMessage } from './relay-protocol'

export const MINTED_TTL_MS = 5 * 60_000
const MINTED_LIMIT = 16

/**
 * The conversations this Mac asked ElevenLabs for, each bound to the Chief of Staff conversation the
 * phone named. A conversation id is good for one connection, for a few minutes after it was minted.
 */
export function createMintedConversations(now: () => number = Date.now) {
    const entries = new Map<string, { chat: DesktopForemanChatRef; expiresAt: number }>()
    const purge = () => { for (const [id, entry] of entries) if (entry.expiresAt <= now()) entries.delete(id) }
    return {
        mint(conversationId: string, chat: DesktopForemanChatRef) {
            purge()
            if (entries.size >= MINTED_LIMIT) entries.delete(entries.keys().next().value!)
            const expiresAt = now() + MINTED_TTL_MS
            entries.set(conversationId, { chat, expiresAt })
            return expiresAt
        },
        withdraw(conversationId: string) { entries.delete(conversationId) },
        claim(conversationId: string): DesktopForemanChatRef | null {
            purge()
            const entry = entries.get(conversationId)
            entries.delete(conversationId)
            return entry?.chat ?? null
        },
        clear() { entries.clear() },
    }
}
export type MintedConversations = ReturnType<typeof createMintedConversations>

/**
 * One connection from ElevenLabs, as the relay hands it over. Nothing is answered until the token
 * ElevenLabs presented checks out against this Mac's key, and nothing reaches the Chief of Staff
 * before an `init` names a conversation this Mac minted and has not used.
 */
export function createUpstreamSession(options: {
    authorization: string
    verify: (authorization: string) => Promise<boolean>
    minted: MintedConversations
    chief: VoiceChief
    send: (message: DownstreamMessage) => void
    close: () => void
    fillerMs?: number
}) {
    let conversation: ReturnType<typeof createVoiceConversation> | null = null
    let ended = false
    const verified = options.verify(options.authorization).catch(() => false)
    let queue: Promise<void> = Promise.resolve()

    function end() {
        if (ended) return
        ended = true
        conversation?.close()
        options.close()
    }

    async function handle(raw: unknown) {
        if (ended) return
        if (!(await verified)) return end()
        const parsed = upstreamMessageSchema.safeParse(raw)
        if (!parsed.success) return
        const message = parsed.data
        switch (message.type) {
            case 'ping': return options.send({ type: 'pong' })
            case 'init': {
                if (conversation) return end()
                const chat = options.minted.claim(message.conversation_id)
                if (!chat) return end()
                conversation = createVoiceConversation({ chat, chief: options.chief, respond: options.send, fillerMs: options.fillerMs })
                return
            }
            case 'user_transcript':
                if (!conversation) return end()
                // Not awaited: a newer utterance has to be able to interrupt this one.
                void conversation.transcript(message.user_transcript, message.event_id).catch(() => {})
                return
            case 'close':
            case 'error':
                return end()
        }
    }

    void verified.then(ok => { if (!ok) end() })
    return {
        frame(raw: unknown) {
            queue = queue.then(() => handle(raw)).catch(() => {})
            return queue
        },
        /** The connection is gone. */
        closed() {
            ended = true
            conversation?.close()
        },
        get ended() { return ended },
    }
}
