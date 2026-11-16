'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { DESKTOP_SPEECH_CHANGED_EVENT, desktopSpeechSettingsSchema, type DesktopSpeechRequest, type DesktopSpeechSettings } from './speech'

export type DesktopSpeechState = {
    /** The reply being fetched or spoken; null when silent. */
    key: string | null
    phase: 'idle' | 'loading' | 'playing'
    /** The last failure, shown on the reply it belongs to until that reply is tried again. */
    error: { key: string; message: string } | null
    /** A reply too long to be read in full: only its first part was spoken. */
    truncated: string | null
}

type Sound = { play(): Promise<void>; pause(): void; onended: ((event: Event) => void) | null; onerror: ((event: Event | string) => void) | null }
type Deps = {
    fetch: typeof fetch
    sound: (url: string) => Sound
    objectUrl: (blob: Blob) => string
    revoke: (url: string) => void
}

const FAILED = 'This reply could not be read aloud. Try again.'
export const desktopSpeechKey = (agentId: string, sessionId: string, messageId: string) => `${agentId}:${sessionId}:${messageId}`
export const DESKTOP_SPEECH_PREVIEW_KEY = 'preview'
/** The Chief of Staff's conversations use the same key shape, under their workspace. */
export const desktopForemanSpeechScope = (workspaceId: string) => `foreman/${workspaceId}`

/** One voice for the whole window: starting a reply stops the one before it. */
export function createDesktopSpeechPlayer(deps: Deps) {
    let state: DesktopSpeechState = { key: null, phase: 'idle', error: null, truncated: null }
    let current: { controller: AbortController; sound?: Sound; url?: string } | null = null
    const listeners = new Set<() => void>()
    const autoSpoken = new Set<string>()
    const set = (next: Partial<DesktopSpeechState>) => { state = { ...state, ...next }; for (const listener of listeners) listener() }

    function release() {
        const playing = current
        current = null
        if (!playing) return
        playing.controller.abort()
        if (playing.sound) { playing.sound.onended = null; playing.sound.onerror = null; try { playing.sound.pause() } catch {} }
        if (playing.url) deps.revoke(playing.url)
    }
    function stop() {
        release()
        if (state.key !== null || state.phase !== 'idle') set({ key: null, phase: 'idle' })
    }
    async function play(key: string, request: DesktopSpeechRequest) {
        release()
        const mine = { controller: new AbortController() } as NonNullable<typeof current>
        current = mine
        set({ key, phase: 'loading', error: null, truncated: null })
        const fail = (message: string) => { if (current === mine) { release(); set({ key: null, phase: 'idle', error: { key, message } }) } }
        try {
            const response = await deps.fetch('/api/desktop/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), cache: 'no-store', signal: mine.controller.signal })
            if (current !== mine) return
            if (!response.ok) {
                const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null
                // Only this route's own plain messages are shown; anything else gets the general one.
                return fail(typeof body?.code === 'string' && body.code.startsWith('speech_') && typeof body.error === 'string' ? body.error.slice(0, 400) : FAILED)
            }
            const truncated = response.headers.get('x-rerun-speech-truncated') === '1'
            const blob = await response.blob()
            if (current !== mine) return
            if (!blob.size) return fail(FAILED)
            mine.url = deps.objectUrl(new Blob([blob], { type: 'audio/mpeg' }))
            const sound = mine.sound = deps.sound(mine.url)
            sound.onended = () => { if (current === mine) stop() }
            sound.onerror = () => fail(FAILED)
            await sound.play()
            if (current === mine) set({ phase: 'playing', truncated: truncated ? key : null })
        } catch {
            fail(FAILED)
        }
    }
    return {
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
        snapshot: () => state,
        play,
        stop,
        /** Stops the voice when it belongs to a conversation the person just left. */
        stopWithin(prefix: string) { if (state.key?.startsWith(prefix)) stop() },
        /** Speaks a finished reply on its own, at most once for each reply while the app runs. */
        autoPlay(key: string, request: DesktopSpeechRequest) {
            if (autoSpoken.has(key)) return false
            autoSpoken.add(key)
            void play(key, request)
            return true
        },
    }
}

export const desktopSpeechPlayer = createDesktopSpeechPlayer({
    fetch: (input, init) => fetch(input, init),
    sound: url => new Audio(url),
    objectUrl: blob => URL.createObjectURL(blob),
    revoke: url => URL.revokeObjectURL(url),
})

const SILENT: DesktopSpeechState = { key: null, phase: 'idle', error: null, truncated: null }
export function useDesktopSpeechPlayer(player = desktopSpeechPlayer): DesktopSpeechState {
    return useSyncExternalStore(player.subscribe, player.snapshot, () => SILENT)
}

// The page hands these over when it loads, so open conversations ask for nothing. After a change in
// Settings they are read again, once for the whole window.
let settingsKnown = false
let settingsRead: Promise<DesktopSpeechSettings | null> | null = null
function readSettings() {
    if (!settingsKnown) return Promise.resolve(null)
    settingsRead ??= (async () => {
        const response = await fetch('/api/desktop/speech', { cache: 'no-store' })
        return response.ok ? desktopSpeechSettingsSchema.parse(await response.json()) : null
    })().catch(() => null)
    return settingsRead
}
function announce(settings: DesktopSpeechSettings | null) {
    settingsKnown = true
    settingsRead = settings ? Promise.resolve(settings) : null
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(DESKTOP_SPEECH_CHANGED_EVENT))
}
/** What the page read on the server as it loaded; null when that read failed. */
export function primeDesktopSpeechSettings(settings: DesktopSpeechSettings | null) { announce(settings) }
export function announceDesktopSpeechChange() { announce(null) }

/** Whether replies can be read aloud here, and how. Null until known, and when it cannot be read. */
export function useDesktopSpeechSettings(active = true): DesktopSpeechSettings | null {
    const [settings, setSettings] = useState<DesktopSpeechSettings | null>(null)
    useEffect(() => {
        if (!active) return
        let live = true
        const load = () => { void readSettings().then(value => { if (live) setSettings(value) }) }
        load()
        window.addEventListener(DESKTOP_SPEECH_CHANGED_EVENT, load)
        return () => { live = false; window.removeEventListener(DESKTOP_SPEECH_CHANGED_EVENT, load) }
    }, [active])
    return settings
}

/**
 * Whether a reply that just finished should be spoken on its own. Only a reply the person watched
 * arrive, in the conversation in front of them, in a focused window, and never a routine's run.
 */
export function desktopAutoReadTarget(input: {
    enabled: boolean; active: boolean; focused: boolean; automated: boolean
    /** Set when a reply finished streaming here: the newest saved reply there was before it. */
    armedAfter: string | null | undefined
    latestSavedId: string | null
}): string | null {
    if (!input.enabled || !input.active || !input.focused || input.automated || input.armedAfter === undefined) return null
    if (!input.latestSavedId || !input.latestSavedId.startsWith('engine-') || input.latestSavedId === input.armedAfter) return null
    return input.latestSavedId
}
