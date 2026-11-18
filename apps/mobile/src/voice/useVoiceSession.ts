import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'

import type { OrbState } from '@/components/orb/ForemanOrb'

import { voiceTurnedOff } from './availability'
import type { VoiceEngine, VoiceEngineSession, VoiceLine, VoiceMode } from './engine'
import { voiceProblemOf, type VoiceProblem } from './problems'

// Everything the conversation needs from outside, handed in so the tests and the lab can stand in
// for the Mac, the voice service and the phone.
export type VoiceDeps = {
    // The Mac's `voice/start`: the token is passed straight to the voice session and kept nowhere.
    requestSession: (chatId: string, signal: AbortSignal) => Promise<{ conversationToken: string }>
    loadEngine: () => Promise<VoiceEngine>
    requestMicrophone: () => Promise<boolean>
    // Pauses the app's own voice messages before the microphone opens.
    yieldAudio: () => Promise<void>
    // A cheap read of the Mac, to notice it went away while talking.
    checkPairing: (signal: AbortSignal) => Promise<unknown>
    watchInterruptions: (onInterrupted: () => void) => () => void
    onLeavingMac: (listener: () => Promise<void> | void) => () => void
}

export type VoicePhase = 'starting' | 'live' | 'ended' | 'failed'

// Why a conversation that started is over: the person closed it, the app left the screen, a call or
// an alarm took the audio, or the other side hung up.
export type VoiceEnding = 'closed' | 'away' | 'interrupted' | 'chief'

export const PAIRING_CHECK_MS = 15_000
// The Mac is only taken for gone after this many reads in a row went unanswered.
const PAIRING_MISSES = 2

type Stop = { phase: 'ended'; ending: VoiceEnding } | { phase: 'failed'; problem: VoiceProblem }

// One voice conversation with the Chief of Staff, from the screen opening to it closing. The
// microphone is open only between `live` and the end, only while the app is on screen.
export function useVoiceSession(chatId: string, deps: VoiceDeps) {
    const [phase, setPhase] = useState<VoicePhase>('starting')
    const [problem, setProblem] = useState<VoiceProblem | null>(null)
    const [ending, setEnding] = useState<VoiceEnding | null>(null)
    const [mode, setMode] = useState<VoiceMode>('listening')
    const [awaitingReply, setAwaitingReply] = useState(false)
    const [muted, setMutedState] = useState(false)
    const [heard, setHeard] = useState<string | null>(null)
    const [said, setSaid] = useState<string | null>(null)

    const depsRef = useRef(deps)
    useEffect(() => {
        depsRef.current = deps
    })
    const sessionRef = useRef<VoiceEngineSession | null>(null)
    const mutedRef = useRef(false)
    const modeRef = useRef<VoiceMode>('listening')
    // Bumped by every start and every stop: whatever a start was still waiting on is dropped.
    const runRef = useRef(0)
    const abortRef = useRef<AbortController | null>(null)
    const phaseRef = useRef<VoicePhase>('starting')
    // iOS's microphone prompt makes the app inactive for as long as it is up: that is not leaving.
    const askingRef = useRef(false)

    const stop = useCallback(async (next: Stop) => {
        runRef.current++
        abortRef.current?.abort()
        abortRef.current = null
        const session = sessionRef.current
        sessionRef.current = null
        phaseRef.current = next.phase
        setPhase(next.phase)
        setProblem(next.phase === 'failed' ? next.problem : null)
        setEnding(next.phase === 'ended' ? next.ending : null)
        mutedRef.current = false
        setMutedState(false)
        if (session) await session.end().catch(() => {})
    }, [])

    // The screen opens on `starting` already: a retry puts it back there first.
    const start = useCallback(async () => {
        const run = ++runRef.current
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller
        phaseRef.current = 'starting'
        modeRef.current = 'listening'
        const current = () => run === runRef.current
        const fail = (reason: VoiceProblem) => {
            if (current()) void stop({ phase: 'failed', problem: reason })
        }
        const { yieldAudio, requestMicrophone, requestSession, loadEngine } = depsRef.current

        await yieldAudio().catch(() => {})
        if (!current()) return
        askingRef.current = true
        const allowed = await requestMicrophone().catch(() => false)
        askingRef.current = false
        if (!allowed) return fail('microphone')
        if (!current()) return

        let conversationToken: string
        try {
            ;({ conversationToken } = await requestSession(chatId, controller.signal))
        } catch (error) {
            if (!current()) return
            const reason = voiceProblemOf(error)
            if (reason === 'notSetUp') voiceTurnedOff()
            return fail(reason)
        }
        if (!current()) return

        try {
            const engine = await loadEngine()
            if (!current()) return
            const session = await engine.start(conversationToken, {
                onMode: next => {
                    if (!current()) return
                    modeRef.current = next
                    setMode(next)
                    if (next === 'speaking') setAwaitingReply(false)
                },
                onLine: (line: VoiceLine) => {
                    if (!current()) return
                    if (line.from === 'you') {
                        setHeard(line.text)
                        setAwaitingReply(true)
                    } else {
                        setSaid(line.text)
                        setAwaitingReply(false)
                    }
                },
                onEnd: why => {
                    if (current()) void stop(why === 'error' ? { phase: 'failed', problem: 'dropped' } : { phase: 'ended', ending: 'chief' })
                },
            })
            if (!current()) {
                await session.end().catch(() => {})
                return
            }
            sessionRef.current = session
            phaseRef.current = 'live'
            setPhase('live')
        } catch {
            fail('failed')
        }
    }, [chatId, stop])

    // Muting waits for the conversation to be live: the session mutes its microphone track, so from
    // the tap on nothing the microphone picks up leaves the phone.
    const setMuted = useCallback((next: boolean) => {
        const session = sessionRef.current
        if (!session || phaseRef.current !== 'live') return
        mutedRef.current = next
        setMutedState(next)
        session.setMuted(next)
    }, [])

    const close = useCallback(() => stop({ phase: 'ended', ending: 'closed' }), [stop])

    const retry = useCallback(() => {
        setPhase('starting')
        setProblem(null)
        setEnding(null)
        setMode('listening')
        setAwaitingReply(false)
        setHeard(null)
        setSaid(null)
        return start()
    }, [start])

    // How loud it is right now, 0 to 1: the Chief of Staff while it speaks, the person otherwise.
    const level = useCallback(() => {
        const session = sessionRef.current
        if (!session) return 0
        if (modeRef.current === 'speaking') return session.outputLevel()
        return mutedRef.current ? 0 : session.inputLevel()
    }, [])

    useEffect(() => {
        // The session starts with the screen; what it sets comes after its first await.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void start()
        return () => void stop({ phase: 'ended', ending: 'closed' })
    }, [start, stop])

    const active = phase === 'starting' || phase === 'live'

    // Foreground only: the conversation ends the moment the app leaves the screen.
    useEffect(() => {
        if (!active) return
        const subscription = AppState.addEventListener('change', state => {
            if (state === 'active' || (state === 'inactive' && askingRef.current)) return
            void stop({ phase: 'ended', ending: 'away' })
        })
        return () => subscription.remove()
    }, [active, stop])

    // A phone call, an alarm or Siri: the conversation ends rather than coming back on its own.
    useEffect(() => {
        if (!active) return
        return depsRef.current.watchInterruptions(() => void stop({ phase: 'ended', ending: 'interrupted' }))
    }, [active, stop])

    // The phone letting go of the Mac (the person left, or the Mac removed it): the microphone closes
    // before the app starts again.
    useEffect(() => {
        if (!active) return
        return depsRef.current.onLeavingMac(() => stop({ phase: 'ended', ending: 'closed' }))
    }, [active, stop])

    // The Mac is read now and then while talking: gone, the conversation stops, since nothing said
    // would reach it any more. A Mac that removed the phone sends the app back to sign in.
    useEffect(() => {
        if (phase !== 'live') return
        let misses = 0
        const controller = new AbortController()
        const timer = setInterval(() => {
            depsRef.current.checkPairing(controller.signal).then(
                () => {
                    misses = 0
                },
                error => {
                    if (controller.signal.aborted) return
                    const removed = (error as { status?: number })?.status === 401
                    if (removed || ++misses >= PAIRING_MISSES) void stop({ phase: 'failed', problem: removed ? 'removed' : 'unreachable' })
                }
            )
        }, PAIRING_CHECK_MS)
        return () => {
            clearInterval(timer)
            controller.abort()
        }
    }, [phase, stop])

    return { phase, problem, ending, mode, awaitingReply, muted, heard, said, setMuted, close, retry, level, orb: orbStateOf({ phase, mode, awaitingReply, muted }) }
}

// The Mac's four states, from what the voice session says: speaking while the Chief of Staff's voice
// plays, thinking between what the person said and its answer, listening while the microphone is open.
export function orbStateOf({ phase, mode, awaitingReply, muted }: { phase: VoicePhase; mode: VoiceMode; awaitingReply: boolean; muted: boolean }): OrbState {
    if (phase !== 'live') return 'idle'
    if (mode === 'speaking') return 'speaking'
    if (awaitingReply) return 'thinking'
    return muted ? 'idle' : 'listening'
}
