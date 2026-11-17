import { randomUUID } from 'node:crypto'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { AGENT_CONTENT_LIMIT, type AgentResponse } from './relay-protocol'
import { createSpokenStream } from './spoken-stream'

export type VoiceCard = 'question' | 'approval' | 'proposal'
export type VoiceReplyChunk = { type: 'text'; partId: string; delta: string } | { type: 'card'; card: VoiceCard }
export type VoiceReplyWatcher = { chunk(chunk: VoiceReplyChunk): void; end(): void }
export type VoiceSendRefusal = 'busy' | 'waiting' | 'model' | 'failed'
export class VoiceSendRefused extends Error {
    constructor(readonly refusal: VoiceSendRefusal) { super(refusal) }
}

/** The Chief of Staff, as a voice conversation uses it: the same send, stop and reply stream as the app. */
export type VoiceChief = {
    /** Throws VoiceSendRefused when the app refuses the message as it would a typed one. */
    send(chat: DesktopForemanChatRef, requestId: string, text: string): Promise<{ runId: string }>
    /** What the Stop button does. */
    stop(chat: DesktopForemanChatRef): Promise<void>
    /** The reply of run `runId` as it streams. Registered before the send, so nothing is missed. */
    watch(runId: string, watcher: VoiceReplyWatcher): Promise<() => void>
}

export const VOICE_FILLER = 'One moment. '
export const VOICE_SENTENCES = {
    question: 'I have a question for you. It is on your screen. ',
    approval: 'I need your approval for something. It is on your screen. ',
    proposal: 'I have put a proposal on your screen for you to look at. ',
    busy: 'I am still working on another message. Try again in a moment. ',
    waiting: 'Something is waiting for you on your screen. Please answer it there first. ',
    model: 'Choose a connected model for the Chief of Staff on your Mac first. ',
    failed: 'I could not take that message. Please try again. ',
    empty: 'Done. The details are on your screen. ',
} as const
const SEND_TEXT_LIMIT = 20_000

type Turn = {
    eventId: number | undefined
    requestId: string
    live: boolean
    spoke: boolean
    started: boolean
    sending?: Promise<void>
    unwatch?: () => void
    filler?: ReturnType<typeof setTimeout>
}

/**
 * One spoken conversation on one Chief of Staff conversation. Each finished utterance is sent as a
 * message through the app's own send path; the reply is spoken as it streams. A newer utterance
 * stops the run in progress the way Stop does, and whatever the old run still says is dropped.
 */
export function createVoiceConversation(options: {
    chat: DesktopForemanChatRef
    chief: VoiceChief
    respond: (message: AgentResponse) => void
    fillerMs?: number
    retryMs?: number
    retries?: number
    newRequestId?: () => string
}) {
    const { chat, chief, respond } = options
    const fillerMs = options.fillerMs ?? 2_000, retryMs = options.retryMs ?? 400, retries = options.retries ?? 12
    let current: Turn | null = null
    let closed = false
    // Set when this conversation stopped a run: the next message waits for that run to settle.
    let stopping = false

    function say(turn: Turn, content: string) {
        if (turn !== current || !turn.live || !content) return
        turn.spoke = true
        for (let offset = 0; offset < content.length; offset += AGENT_CONTENT_LIMIT) {
            respond({ type: 'agent_response', content: content.slice(offset, offset + AGENT_CONTENT_LIMIT), event_id: turn.eventId, is_final: false })
        }
    }

    function finish(turn: Turn, last = '') {
        if (!turn.live) return
        say(turn, last)
        turn.live = false
        if (turn.filler) clearTimeout(turn.filler)
        turn.unwatch?.()
        if (turn === current) respond({ type: 'agent_response', content: '', event_id: turn.eventId, is_final: true })
    }

    function abandon(turn: Turn) {
        turn.live = false
        if (turn.filler) clearTimeout(turn.filler)
        turn.unwatch?.()
    }

    async function transcript(entries: readonly { role: 'user' | 'agent'; content: string }[], eventId: number | undefined) {
        if (closed) return
        if (current && eventId !== undefined && current.eventId !== undefined) {
            // A repeat of the utterance being answered, or one older than it, changes nothing.
            if (eventId <= current.eventId) return
        }
        const previous = current
        const turn: Turn = { eventId, requestId: (options.newRequestId ?? randomUUID)(), live: true, spoke: false, started: false }
        current = turn
        if (previous?.live) {
            abandon(previous)
            await previous.sending
            if (previous.started) {
                stopping = true
                await chief.stop(chat).catch(() => {})
            }
        }
        if (turn !== current) return
        const text = [...entries].reverse().find(entry => entry.role === 'user')?.content.trim().slice(0, SEND_TEXT_LIMIT) ?? ''
        if (!text) return finish(turn)
        turn.filler = setTimeout(() => { if (!turn.spoke) say(turn, VOICE_FILLER) }, fillerMs)

        const stream = createSpokenStream()
        let partId: string | null = null
        const unwatch = await chief.watch(turn.requestId, {
            chunk(chunk) {
                if (turn !== current || !turn.live) return
                if (chunk.type === 'card') return finish(turn, stream.end() + VOICE_SENTENCES[chunk.card])
                const separator = partId !== null && partId !== chunk.partId ? '\n\n' : ''
                partId = chunk.partId
                say(turn, stream.append(separator + chunk.delta))
            },
            end() {
                if (turn !== current || !turn.live) return
                const rest = stream.end()
                finish(turn, rest || (turn.spoke && partId !== null ? '' : VOICE_SENTENCES.empty))
            },
        })
        if (turn !== current || !turn.live) return unwatch()
        turn.unwatch = unwatch
        turn.sending = (async () => {
            for (let attempt = 0; ; attempt++) {
                try {
                    await chief.send(chat, turn.requestId, text)
                    turn.started = true
                    stopping = false
                    return
                } catch (error) {
                    if (turn !== current || !turn.live) return
                    const refusal = error instanceof VoiceSendRefused ? error.refusal : 'failed'
                    // The run just stopped takes a moment to settle before the next message is taken.
                    if (refusal === 'busy' && stopping && attempt < retries) {
                        await new Promise(resolve => setTimeout(resolve, retryMs))
                        if (turn !== current || !turn.live) return
                        continue
                    }
                    return finish(turn, VOICE_SENTENCES[refusal])
                }
            }
        })()
        await turn.sending
    }

    return {
        transcript,
        /** The call ended. A reply still running finishes on the Mac and stays in the conversation. */
        close() {
            closed = true
            if (current) abandon(current)
            current = null
        },
    }
}
