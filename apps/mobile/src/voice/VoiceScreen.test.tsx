import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native'
import * as SecureStore from 'expo-secure-store'
import { AppState, type AppStateStatus } from 'react-native'

import { resetVoiceOffer, useVoiceOffered } from './availability'
import type { VoiceEngine, VoiceEngineEvents, VoiceEngineSession } from './engine'
import { PAIRING_CHECK_MS, type VoiceDeps } from './useVoiceSession'
import { VoiceScreen } from './VoiceScreen'

jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }))
jest.mock('@/components/ui/Icon', () => ({ Icon: () => null }))
// The orb is drawn by Reanimated and SVG; here it says which of the four states it shows.
jest.mock('./VoiceOrb', () => {
    const { Text: MockText } = require('react-native')
    return { VoiceOrb: ({ state }: { state: string }) => <MockText testID="voice-orb">{state}</MockText> }
})
jest.mock('expo-secure-store', () => ({ setItemAsync: jest.fn(async () => {}), getItemAsync: jest.fn(async () => null), deleteItemAsync: jest.fn(async () => {}), getItem: jest.fn(() => null), setItem: jest.fn() }))

const CHAT = 'fmc_11111111-1111-4111-8111-111111111111'
const TOKEN = 'secret-conversation-token-1234'

class Refusal extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
    }
}

function fakeEngine() {
    let events: VoiceEngineEvents | null = null
    const session: jest.Mocked<VoiceEngineSession> = {
        end: jest.fn(async () => {}),
        setMuted: jest.fn(),
        inputLevel: jest.fn(() => 0.6),
        outputLevel: jest.fn(() => 0.3),
    }
    const engine: VoiceEngine = {
        start: jest.fn(async (_token: string, handlers: VoiceEngineEvents) => {
            events = handlers
            return session
        }),
    }
    return { engine, session, events: () => events! }
}

function fakeDeps(overrides: Partial<VoiceDeps> = {}) {
    const voice = fakeEngine()
    const interruptions: (() => void)[] = []
    const leaving: (() => Promise<void> | void)[] = []
    const deps: jest.Mocked<VoiceDeps> = {
        requestSession: jest.fn(async () => ({ conversationToken: TOKEN, conversationId: 'conv_1', expiresAt: '2026-11-17T12:00:00Z' })),
        loadEngine: jest.fn(async () => voice.engine),
        requestMicrophone: jest.fn(async () => true),
        yieldAudio: jest.fn(async () => {}),
        checkPairing: jest.fn(async () => ({})),
        watchInterruptions: jest.fn(listener => {
            interruptions.push(listener)
            return () => {}
        }),
        onLeavingMac: jest.fn(listener => {
            leaving.push(listener)
            return () => {}
        }),
        ...overrides,
    } as jest.Mocked<VoiceDeps>
    return { deps, ...voice, interrupt: () => interruptions.at(-1)?.(), leaveMac: () => Promise.all(leaving.map(listener => listener())) }
}

async function open(deps: VoiceDeps, onClose = jest.fn()) {
    await render(<VoiceScreen chatId={CHAT} onClose={onClose} deps={deps} />)
    await act(async () => {})
    return onClose
}

const caption = () => screen.getByTestId('voice-caption').props.children
const orb = () => screen.getByTestId('voice-orb').props.children
const micShown = () => screen.getByTestId('voice-mic-on', { includeHiddenElements: true }).props.style.opacity === 1

let appStateListeners: ((state: AppStateStatus) => void)[] = []

beforeEach(() => {
    resetVoiceOffer()
    appStateListeners = []
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
        appStateListeners.push(listener as (state: AppStateStatus) => void)
        return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>
    })
})

afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
})

describe('the voice screen', () => {
    it('stops the app\'s own audio, asks for the microphone, then starts the session with the Mac\'s token for this conversation', async () => {
        const { deps, engine } = fakeDeps()
        await open(deps)
        expect(deps.yieldAudio.mock.invocationCallOrder[0]).toBeLessThan(deps.requestMicrophone.mock.invocationCallOrder[0])
        expect(deps.requestMicrophone.mock.invocationCallOrder[0]).toBeLessThan(deps.requestSession.mock.invocationCallOrder[0])
        expect(deps.requestSession).toHaveBeenCalledWith(CHAT, expect.any(AbortSignal))
        expect(engine.start).toHaveBeenCalledWith(TOKEN, expect.any(Object))
        expect(caption()).toBe('Listening')
        expect(orb()).toBe('listening')
        expect(micShown()).toBe(true)
    })

    it('goes from listening to thinking to speaking with what the session says, and shows the last lines', async () => {
        const { deps, events } = fakeDeps()
        await open(deps)
        await act(async () => events().onLine({ from: 'you', text: 'What is on my plate today?' }))
        expect(orb()).toBe('thinking')
        expect(caption()).toBe('Thinking')
        await act(async () => events().onMode('speaking'))
        await act(async () => events().onLine({ from: 'chief', text: 'Two reviews and the launch.' }))
        expect(orb()).toBe('speaking')
        expect(caption()).toBe('Speaking')
        expect(screen.getByText(/What is on my plate today\?/)).toBeTruthy()
        expect(screen.getByText(/Two reviews and the launch\./)).toBeTruthy()
        await act(async () => events().onMode('listening'))
        expect(orb()).toBe('listening')
    })

    it.each([
        [new Refusal(404, 'not_found'), 'Voice is not set up on your Mac. In Rerun on your Mac, turn on Allow voice conversations from paired phones.', false],
        [new Refusal(503, 'unavailable'), 'Your Mac cannot start a voice conversation right now: its voice connection is down. Try again in a moment.', true],
        [new Refusal(403, 'send_not_allowed'), 'This phone may not send messages. On your Mac, open Connect iPhone and turn on Send messages for it.', false],
        [new Refusal(429, 'rate_limited'), 'Too many tries. Wait a minute, then try again.', true],
        [new TypeError('Network request failed'), 'Could not reach your Mac.', true],
    ])('says why the Mac refused (%s) in plain words', async (refusal, words, retryable) => {
        const { deps, engine } = fakeDeps({ requestSession: jest.fn(async () => Promise.reject(refusal)) })
        await open(deps)
        expect(caption()).toBe(words)
        expect(engine.start).not.toHaveBeenCalled()
        expect(screen.queryByText('Try again') !== null).toBe(retryable)
        expect(screen.queryByTestId('voice-mute')).toBeNull()
    })

    it('hides the voice button for the rest of the run once the Mac says voice is not set up', async () => {
        const offered = await renderHook(() => useVoiceOffered())
        expect(offered.result.current).toBe(true)
        const { deps } = fakeDeps({ requestSession: jest.fn(async () => Promise.reject(new Refusal(404, 'not_found'))) })
        await open(deps)
        expect(offered.result.current).toBe(false)
    })

    it('keeps the button after a refusal that is not about voice being off', async () => {
        const offered = await renderHook(() => useVoiceOffered())
        const { deps } = fakeDeps({ requestSession: jest.fn(async () => Promise.reject(new Refusal(503, 'unavailable'))) })
        await open(deps)
        expect(offered.result.current).toBe(true)
    })

    it('asks nothing of the Mac without the microphone, and says so', async () => {
        const { deps } = fakeDeps({ requestMicrophone: jest.fn(async () => false) })
        await open(deps)
        expect(deps.requestSession).not.toHaveBeenCalled()
        expect(caption()).toBe('Rerun may not use the microphone. Allow it in Settings, then try again.')
        expect(screen.getByText('Open Settings')).toBeTruthy()
    })

    it('says the connection dropped when the session breaks', async () => {
        const { deps, events } = fakeDeps()
        await open(deps)
        await act(async () => events().onEnd('error'))
        expect(caption()).toBe('The connection dropped.')
        expect(micShown()).toBe(false)
    })

    it('starts again after a failure', async () => {
        const requestSession = jest.fn().mockRejectedValueOnce(new Refusal(429, 'rate_limited')).mockResolvedValue({ conversationToken: TOKEN })
        const { deps, engine } = fakeDeps({ requestSession })
        await open(deps)
        await fireEvent.press(screen.getByText('Try again'))
        await act(async () => {})
        expect(engine.start).toHaveBeenCalledTimes(1)
        expect(caption()).toBe('Listening')
    })

    it('mutes the microphone at the source, shows it, and sends nothing while muted', async () => {
        const { deps, session } = fakeDeps()
        await open(deps)
        await fireEvent.press(screen.getByLabelText('Mute the microphone'))
        expect(session.setMuted).toHaveBeenLastCalledWith(true)
        expect(caption()).toBe('Muted. Nothing you say is sent.')
        expect(orb()).toBe('idle')
        expect(micShown()).toBe(false)
        await fireEvent.press(screen.getByLabelText('Turn the microphone back on'))
        expect(session.setMuted).toHaveBeenLastCalledWith(false)
        expect(caption()).toBe('Listening')
    })

    it('cannot be muted before the session is live, so the mute never comes after the microphone opened', async () => {
        let finish: (value: { conversationToken: string }) => void = () => {}
        const { deps, session } = fakeDeps({ requestSession: jest.fn(() => new Promise<{ conversationToken: string }>(resolve => (finish = resolve))) })
        await open(deps)
        expect(caption()).toBe('Connecting through your Mac…')
        expect(screen.getByTestId('voice-mute').props.accessibilityState).toMatchObject({ disabled: true })
        await fireEvent.press(screen.getByTestId('voice-mute'))
        expect(session.setMuted).not.toHaveBeenCalled()
        await act(async () => finish({ conversationToken: TOKEN }))
        expect(caption()).toBe('Listening')
    })

    it('ends the session and closes on the close button', async () => {
        const { deps, session } = fakeDeps()
        const onClose = await open(deps)
        await fireEvent.press(screen.getByLabelText('End the conversation'))
        expect(session.end).toHaveBeenCalledTimes(1)
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('ends the session when the app leaves the screen', async () => {
        const { deps, session } = fakeDeps()
        await open(deps)
        await act(async () => appStateListeners.forEach(listener => listener('background')))
        expect(session.end).toHaveBeenCalledTimes(1)
        expect(caption()).toBe('The conversation ended when Rerun left the screen.')
        expect(screen.queryByTestId('voice-mute')).toBeNull()
    })

    it('stays up while the microphone prompt covers the app, and still ends if the app leaves then', async () => {
        let answer: (granted: boolean) => void = () => {}
        const { deps, engine } = fakeDeps({ requestMicrophone: jest.fn(() => new Promise<boolean>(resolve => (answer = resolve))) })
        await open(deps)
        await act(async () => appStateListeners.forEach(listener => listener('inactive')))
        await act(async () => answer(true))
        await act(async () => appStateListeners.forEach(listener => listener('active')))
        expect(engine.start).toHaveBeenCalled()
        expect(caption()).toBe('Listening')
        await act(async () => appStateListeners.forEach(listener => listener('inactive')))
        expect(caption()).toBe('The conversation ended when Rerun left the screen.')
    })

    it('ends the session on a call or another audio interruption', async () => {
        const { deps, session, interrupt } = fakeDeps()
        await open(deps)
        await act(async () => interrupt())
        expect(session.end).toHaveBeenCalledTimes(1)
        expect(caption()).toBe('The conversation ended for a call or another sound on this phone.')
    })

    it('ends the session before the phone lets go of the Mac', async () => {
        const { deps, session, leaveMac } = fakeDeps()
        await open(deps)
        await act(async () => void (await leaveMac()))
        expect(session.end).toHaveBeenCalledTimes(1)
    })

    it('ends the session when the Mac removes the phone or stops answering', async () => {
        jest.useFakeTimers()
        const removed = fakeDeps({ checkPairing: jest.fn(async () => Promise.reject(new Refusal(401, 'revoked'))) })
        await open(removed.deps)
        await act(async () => void jest.advanceTimersByTime(PAIRING_CHECK_MS))
        expect(removed.session.end).toHaveBeenCalledTimes(1)
        expect(caption()).toBe('Your Mac no longer accepts this phone.')
        await screen.unmount()

        const gone = fakeDeps({ checkPairing: jest.fn(async () => Promise.reject(new TypeError('Network request failed'))) })
        await open(gone.deps)
        await act(async () => void jest.advanceTimersByTime(PAIRING_CHECK_MS))
        expect(gone.session.end).not.toHaveBeenCalled()
        await act(async () => void jest.advanceTimersByTime(PAIRING_CHECK_MS))
        expect(gone.session.end).toHaveBeenCalledTimes(1)
        expect(caption()).toBe('Could not reach your Mac.')
    })

    it('ends the session when the screen goes away', async () => {
        const { deps, session } = fakeDeps()
        await open(deps)
        await screen.unmount()
        await act(async () => {})
        expect(session.end).toHaveBeenCalledTimes(1)
    })

    it('ends a session that only came up after the screen closed', async () => {
        let started: (session: VoiceEngineSession) => void = () => {}
        const { deps, session } = fakeDeps()
        deps.loadEngine.mockResolvedValue({ start: jest.fn(() => new Promise<VoiceEngineSession>(resolve => (started = resolve))) })
        await open(deps)
        await screen.unmount()
        await act(async () => started(session))
        expect(session.end).toHaveBeenCalledTimes(1)
    })

    it('never logs, shows or stores the token', async () => {
        const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => jest.spyOn(console, method).mockImplementation(() => {}))
        const { deps, events } = fakeDeps()
        await open(deps)
        await act(async () => events().onLine({ from: 'you', text: 'Hello' }))
        await act(async () => events().onEnd('error'))
        expect(JSON.stringify(screen.toJSON())).not.toContain(TOKEN)
        for (const spy of logged) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN)
        expect(JSON.stringify(jest.mocked(SecureStore.setItemAsync).mock.calls)).not.toContain(TOKEN)
        expect(jest.mocked(SecureStore.setItem)).not.toHaveBeenCalled()
    })
})
