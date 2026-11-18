import { fireEvent, render, screen } from '@testing-library/react-native'

import { Composer } from '@/components/chat/Composer'
import { holdAudio, yieldAudio } from '@/lib/audio-yield'

import { resetVoiceOffer, talkableChat } from './availability'
import { watchInterruptions } from './interruptions'
import { canRetry, voiceProblemOf } from './problems'
import { orbStateOf } from './useVoiceSession'

jest.mock('@/components/ui/Icon', () => ({ Icon: () => null }))
jest.mock('@/components/ui/NativeMenu', () => ({ NativeMenu: () => null, MenuItem: () => null, SubMenu: () => null, MenuToggle: () => null }))
jest.mock('@/components/ui/GlassSurface', () => {
    const { View: MockView } = require('react-native')
    return { GlassSurface: ({ children }: { children: unknown }) => <MockView>{children}</MockView> }
})
jest.mock('@/chat/composer-paste', () => ({ addPasteImagesListener: () => () => {} }))

const CHAT = 'fmc_11111111-1111-4111-8111-111111111111'

describe('whether the composer offers to talk', () => {
    beforeEach(resetVoiceOffer)

    it('offers it on a Chief of Staff conversation of a paired Mac', () => {
        expect(talkableChat({ chiefOnMac: true, offered: true, busy: false, sessionId: CHAT })).toBe(CHAT)
    })

    it('hides it once the Mac said voice is off, off a Mac, without a conversation yet, and while a reply is written', () => {
        expect(talkableChat({ chiefOnMac: true, offered: false, busy: false, sessionId: CHAT })).toBeNull()
        expect(talkableChat({ chiefOnMac: false, offered: true, busy: false, sessionId: CHAT })).toBeNull()
        expect(talkableChat({ chiefOnMac: true, offered: true, busy: false, sessionId: null })).toBeNull()
        expect(talkableChat({ chiefOnMac: true, offered: true, busy: true, sessionId: CHAT })).toBeNull()
        expect(talkableChat({ chiefOnMac: true, offered: true, busy: false, sessionId: 'chat-1' })).toBeNull()
    })

    it('shows the button when given one and leaves it out otherwise', async () => {
        const onTalk = jest.fn()
        const composer = (talk?: { label: string; onPress: () => void }) => <Composer value="" onChangeText={() => {}} onSend={() => {}} onStop={() => {}} running={false} placeholder="Message" canAttach={false} talk={talk} />
        await render(composer({ label: 'Talk with the Chief of Staff', onPress: onTalk }))
        await fireEvent.press(screen.getByLabelText('Talk with the Chief of Staff'))
        expect(onTalk).toHaveBeenCalledTimes(1)
        await screen.rerender(composer(undefined))
        expect(screen.queryByLabelText('Talk with the Chief of Staff')).toBeNull()
    })

    it('steps the button out once there is text to send', async () => {
        await render(<Composer value="Hello" onChangeText={() => {}} onSend={() => {}} onStop={() => {}} running={false} placeholder="Message" canAttach={false} talk={{ label: 'Talk with the Chief of Staff', onPress: () => {} }} />)
        expect(screen.queryByLabelText('Talk with the Chief of Staff')).toBeNull()
    })
})

describe('the Mac\'s refusals', () => {
    it.each([
        [{ status: 404, message: 'not_found' }, 'notSetUp'],
        [{ status: 503, message: 'unavailable' }, 'unavailable'],
        [{ status: 403, message: 'send_not_allowed' }, 'notAllowed'],
        [{ status: 429, message: 'rate_limited' }, 'rateLimited'],
        [{ status: 401, message: 'revoked' }, 'removed'],
        [new TypeError('Network request failed'), 'unreachable'],
    ])('reads %j as %s', (error, problem) => {
        expect(voiceProblemOf(error)).toBe(problem)
    })

    it('offers no retry where only the Mac can change the answer', () => {
        expect(['notSetUp', 'notAllowed', 'removed'].map(problem => canRetry(problem as never))).toEqual([false, false, false])
        expect(['unavailable', 'rateLimited', 'microphone', 'dropped', 'unreachable', 'failed'].map(problem => canRetry(problem as never))).toEqual([true, true, true, true, true, true])
    })
})

describe('the orb', () => {
    it('follows the Mac\'s four states', () => {
        expect(orbStateOf({ phase: 'starting', mode: 'listening', awaitingReply: false, muted: false })).toBe('idle')
        expect(orbStateOf({ phase: 'live', mode: 'listening', awaitingReply: false, muted: false })).toBe('listening')
        expect(orbStateOf({ phase: 'live', mode: 'listening', awaitingReply: true, muted: false })).toBe('thinking')
        expect(orbStateOf({ phase: 'live', mode: 'speaking', awaitingReply: false, muted: false })).toBe('speaking')
        expect(orbStateOf({ phase: 'live', mode: 'listening', awaitingReply: false, muted: true })).toBe('idle')
        expect(orbStateOf({ phase: 'failed', mode: 'speaking', awaitingReply: false, muted: false })).toBe('idle')
    })
})

describe('what ends a conversation from outside', () => {
    it('listens for interruptions only while the conversation is up, and does nothing without the native module', () => {
        const listeners: ((event: { kind: string }) => void)[] = []
        const remove = jest.fn()
        const native = { addListener: jest.fn((_event: 'onInterruption', listener: (event: { kind: string }) => void) => (listeners.push(listener), { remove })) }
        const interrupted = jest.fn()
        const stop = watchInterruptions(interrupted, native)
        expect(native.addListener).toHaveBeenCalledWith('onInterruption', expect.any(Function))
        listeners[0]({ kind: 'audio' })
        expect(interrupted).toHaveBeenCalledTimes(1)
        stop()
        expect(remove).toHaveBeenCalled()
        expect(() => watchInterruptions(interrupted, null)()).not.toThrow()
    })

    it('pauses the app\'s players and recorders before the microphone opens', async () => {
        const pause = jest.fn()
        const release = holdAudio(pause)
        await yieldAudio()
        expect(pause).toHaveBeenCalledTimes(1)
        release()
        await yieldAudio()
        expect(pause).toHaveBeenCalledTimes(1)
    })
})
