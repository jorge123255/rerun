import { useSyncExternalStore } from 'react'

// Whether the Chief of Staff's composer offers to talk. The Mac has no cheaper way to say voice is
// on than the start itself: the button shows until a start is answered `not_found` (the switch is off
// on the Mac, or the Mac is older than voice), then stays hidden until the app starts again.
let turnedOff = false
const listeners = new Set<() => void>()

export function voiceTurnedOff(): void {
    if (turnedOff) return
    turnedOff = true
    for (const listener of listeners) listener()
}

export function useVoiceOffered(): boolean {
    return useSyncExternalStore(
        listener => {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
        () => !turnedOff
    )
}

// A Chief of Staff conversation id, as the Mac's voice start takes it.
const CHIEF_CHAT = /^fmc_[A-Za-z0-9-]{8,80}$/

// The conversation the composer offers to talk in, or null for no button: only the Chief of Staff of a
// paired Mac, only while the Mac has not said voice is off, only on a conversation that exists, and not
// while a reply is being written.
export function talkableChat({ chiefOnMac, offered, busy, sessionId }: { chiefOnMac: boolean; offered: boolean; busy: boolean; sessionId: string | null }): string | null {
    if (!chiefOnMac || !offered || busy || !sessionId) return null
    return CHIEF_CHAT.test(sessionId) ? sessionId : null
}

// Tests only: every test starts with voice offered.
export function resetVoiceOffer(): void {
    turnedOff = false
    for (const listener of listeners) listener()
}
