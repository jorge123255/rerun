'use client'

import { useEffect, useRef } from 'react'
import { desktopAutoReadTarget, desktopSpeechKey, desktopSpeechPlayer, useDesktopSpeechSettings } from '@/lib/desktop/speech-player'

/** A finished reply is spoken on its own only while it is still news. */
const ARMED_FOR_MS = 30_000

/**
 * Speech for one open conversation: whether its replies offer "Read aloud", silence when the person
 * leaves it, and, when the workspace switch is on, speaking a reply once as it finishes arriving.
 */
export function useDesktopSpokenReplies({ agentId, sessionId, liveSessionId, active, streaming, automated, latestSavedId, player = desktopSpeechPlayer }: {
    /** The coworker, or the scope the Chief of Staff's conversations are keyed under. */
    agentId: string
    sessionId: string | null
    liveSessionId: string | null
    active: boolean
    /** A reply is arriving in this conversation right now. */
    streaming: boolean
    /** The conversation belongs to a routine, a trigger or another coworker's call. */
    automated: boolean
    /** The newest saved reply with words in it. */
    latestSavedId: string | null
    player?: typeof desktopSpeechPlayer
}) {
    const settings = useDesktopSpeechSettings(active)

    useEffect(() => {
        if (!sessionId || !active) return
        const prefix = desktopSpeechKey(agentId, sessionId, '')
        return () => player.stopWithin(prefix)
    }, [agentId, sessionId, active, player])

    const watch = useRef<{ session: string | null; wasStreaming: boolean; seen: string | null; armed?: { after: string | null; at: number } }>({ session: sessionId, wasStreaming: false, seen: latestSavedId })
    const autoRead = !!settings?.configured && settings.autoRead
    useEffect(() => {
        const state = watch.current
        if (state.session !== sessionId) {
            // A new conversation receiving its id keeps its watch; any other change starts over.
            const adopted = state.session === null && sessionId === liveSessionId
            state.session = sessionId
            if (!adopted) { state.wasStreaming = streaming; state.seen = latestSavedId; state.armed = undefined; return }
        }
        if (streaming) { state.wasStreaming = true; state.armed = undefined; return }
        if (state.wasStreaming) { state.wasStreaming = false; state.armed = { after: state.seen, at: Date.now() } }
        if (!state.armed) { state.seen = latestSavedId; return }
        if (Date.now() - state.armed.at > ARMED_FOR_MS) { state.armed = undefined; state.seen = latestSavedId; return }
        // The saved copy of the reply has not been read back yet.
        if (!sessionId || !latestSavedId || latestSavedId === state.armed.after) return
        const target = desktopAutoReadTarget({ enabled: autoRead, active, focused: typeof document !== 'undefined' && document.hasFocus(), automated, armedAfter: state.armed.after, latestSavedId })
        state.armed = undefined
        state.seen = latestSavedId
        if (target) player.autoPlay(desktopSpeechKey(agentId, sessionId, target), { agentId, sessionId, messageId: target })
    }, [agentId, sessionId, liveSessionId, active, streaming, automated, latestSavedId, autoRead, player])

    return { available: !!settings?.configured }
}
