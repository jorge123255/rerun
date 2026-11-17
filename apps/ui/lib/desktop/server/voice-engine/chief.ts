import 'server-only'
import { stripBridgePrefix, type DesktopForemanChatRef } from '@rerun/contracts'
import type { UIMessageChunk } from 'ai'
import { DesktopHttpError } from '../auth'
import { ForemanRefusal } from '../foreman/authority'
import { desktopForeman, type ForemanReplyWatcher } from '../foreman/binding'
import { ownedForemanChat } from '../foreman/chat-store'
import { stopDesktopForemanChat } from '../foreman/stop'
import type { DesktopRuntime } from '../runtime'
import { VoiceSendRefused, type VoiceCard, type VoiceChief, type VoiceReplyWatcher, type VoiceSendRefusal } from './conversation'

// The tools that put a card on the Mac's screen for the owner to answer or look at.
export const VOICE_CARD_TOOLS: Readonly<Record<string, VoiceCard>> = {
    ask_user: 'question', request_approval: 'approval', show_plan: 'proposal', propose_team_changes: 'proposal',
}

/** The run's raw stream as a voice conversation reads it: its text, and any card it shows. Tool output is never text. */
export function voiceReplyChunks(runId: string, watcher: VoiceReplyWatcher): ForemanReplyWatcher {
    let started = false, ended = false
    const end = () => { if (!ended) { ended = true; watcher.end() } }
    return {
        chunk(chunk: UIMessageChunk) {
            if (ended) return
            if (chunk.type === 'start') { started = chunk.messageId === runId; return }
            if (!started) return
            if (chunk.type === 'text-delta') return watcher.chunk({ type: 'text', partId: chunk.id, delta: chunk.delta })
            if (chunk.type === 'tool-input-start' || chunk.type === 'tool-input-available') {
                const card = VOICE_CARD_TOOLS[stripBridgePrefix(chunk.toolName)]
                if (card) watcher.chunk({ type: 'card', card })
                return
            }
            if (chunk.type === 'abort' || chunk.type === 'error') end()
        },
        end,
    }
}

export function voiceSendRefusal(error: unknown): VoiceSendRefusal {
    if (error instanceof ForemanRefusal) return error.failure === 'model_unavailable' ? 'model' : 'failed'
    if (error instanceof DesktopHttpError && error.status === 409) {
        if (/question|approval|starter|offer|recording/i.test(error.message)) return 'waiting'
        if (/settle|wait/i.test(error.message)) return 'busy'
    }
    return 'failed'
}

/** The Chief of Staff through the app's own paths: the send the composer uses, and the Stop button. */
export function desktopVoiceChief(runtime: DesktopRuntime): VoiceChief & { assertChat(chat: DesktopForemanChatRef): Promise<void> } {
    return {
        async assertChat(chat) {
            if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Not found')
            await ownedForemanChat((await desktopForeman(runtime)).db, chat)
        },
        async send(chat, requestId, text) {
            const app = await desktopForeman(runtime)
            try { return await app.send(chat, requestId, text) } catch (error) { throw new VoiceSendRefused(voiceSendRefusal(error)) }
        },
        async stop(chat) {
            await stopDesktopForemanChat(runtime, await desktopForeman(runtime), chat)
        },
        async watch(runId, watcher) {
            return (await desktopForeman(runtime)).watchReply(runId, voiceReplyChunks(runId, watcher))
        },
    }
}
