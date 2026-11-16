import { describe, expect, it, vi } from 'vitest'
import { createDesktopSpeechPlayer, desktopAutoReadTarget, desktopSpeechKey } from './speech-player'

type FakeSound = { url: string; playing: boolean; paused: boolean; play: () => Promise<void>; pause: () => void; onended: ((event: Event) => void) | null; onerror: ((event: Event | string) => void) | null }

function fixture(reply: (body: unknown, signal: AbortSignal) => Response | Promise<Response> = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } })) {
    const sounds: FakeSound[] = [], revoked: string[] = [], requests: { body: unknown; signal: AbortSignal }[] = []
    const player = createDesktopSpeechPlayer({
        fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)), signal = init!.signal!
            requests.push({ body, signal })
            return reply(body, signal)
        }) as unknown as typeof fetch,
        sound: url => {
            const sound: FakeSound = { url, playing: false, paused: false, onended: null, onerror: null, play: async () => { sound.playing = true }, pause: () => { sound.playing = false; sound.paused = true } }
            sounds.push(sound)
            return sound
        },
        objectUrl: () => `blob:test-${sounds.length + 1}`,
        revoke: url => { revoked.push(url) },
    })
    return { player, sounds, revoked, requests }
}
const reply = (id: string) => ({ agentId: '6f1b6a0e-6a52-4f0b-9d5e-0c1f8f0e1a11', sessionId: '6f1b6a0e-6a52-4f0b-9d5e-0c1f8f0e1a12', messageId: `engine-${id}` })
const keyOf = (id: string) => { const value = reply(id); return desktopSpeechKey(value.agentId, value.sessionId, value.messageId) }

describe('one voice at a time', () => {
    it('names only the reply when asking for audio, then plays it and falls silent at the end', async () => {
        const { player, sounds, revoked, requests } = fixture()
        const seen: string[] = []
        player.subscribe(() => seen.push(player.snapshot().phase))
        await player.play(keyOf('a'), reply('a'))
        expect(requests[0].body).toEqual(reply('a'))
        expect(player.snapshot()).toEqual({ key: keyOf('a'), phase: 'playing', error: null, truncated: null })
        expect(seen).toEqual(['loading', 'playing'])
        sounds[0].onended?.(new Event('ended'))
        expect(player.snapshot()).toMatchObject({ key: null, phase: 'idle' })
        expect(revoked).toEqual(['blob:test-1'])
    })

    it('stops the first reply when a second one starts', async () => {
        const { player, sounds, revoked } = fixture()
        await player.play(keyOf('a'), reply('a'))
        await player.play(keyOf('b'), reply('b'))
        expect(sounds).toHaveLength(2)
        expect(sounds[0]).toMatchObject({ playing: false, paused: true })
        expect(sounds[1].playing).toBe(true)
        expect(revoked).toEqual(['blob:test-1'])
        expect(player.snapshot()).toMatchObject({ key: keyOf('b'), phase: 'playing' })
        // The first reply's ending can no longer silence the second.
        expect(sounds[0].onended).toBeNull()
    })

    it('drops a reply still being fetched when another starts, and never plays it', async () => {
        let release!: (response: Response) => void
        const { player, sounds, requests } = fixture(body => (body as { messageId: string }).messageId === 'engine-a'
            ? new Promise<Response>(resolve => { release = resolve }) : new Response(new Uint8Array([9])))
        const first = player.play(keyOf('a'), reply('a'))
        await Promise.resolve()
        await player.play(keyOf('b'), reply('b'))
        expect(requests[0].signal.aborted).toBe(true)
        release(new Response(new Uint8Array([1])))
        await first
        expect(sounds).toHaveLength(1)
        expect(player.snapshot()).toMatchObject({ key: keyOf('b'), phase: 'playing' })
    })

    it('stops on request, and when the person leaves the conversation the voice belongs to', async () => {
        const { player, sounds } = fixture()
        await player.play(keyOf('a'), reply('a'))
        player.stopWithin(desktopSpeechKey('another-coworker', 'another-chat', ''))
        expect(sounds[0].playing).toBe(true)
        player.stopWithin(desktopSpeechKey(reply('a').agentId, reply('a').sessionId, ''))
        expect(sounds[0]).toMatchObject({ playing: false, paused: true })
        expect(player.snapshot()).toMatchObject({ key: null, phase: 'idle' })
        await player.play(keyOf('a'), reply('a'))
        player.stop()
        expect(sounds[1].paused).toBe(true)
    })

    it('shows the route’s plain message on the reply it belongs to, and a general one for anything else', async () => {
        const quota = fixture(() => Response.json({ code: 'speech_quota', error: 'Your ElevenLabs account has no credits left for this.' }, { status: 502 }))
        await quota.player.play(keyOf('a'), reply('a'))
        expect(quota.player.snapshot()).toEqual({ key: null, phase: 'idle', error: { key: keyOf('a'), message: 'Your ElevenLabs account has no credits left for this.' }, truncated: null })
        expect(quota.sounds).toHaveLength(0)
        const other = fixture(() => Response.json({ error: 'Unauthorized' }, { status: 401 }))
        await other.player.play(keyOf('a'), reply('a'))
        expect(other.player.snapshot().error).toEqual({ key: keyOf('a'), message: 'This reply could not be read aloud. Try again.' })
        const offline = fixture(() => { throw new TypeError('Failed to fetch') })
        await offline.player.play(keyOf('a'), reply('a'))
        expect(offline.player.snapshot().error?.message).toBe('This reply could not be read aloud. Try again.')
        // Trying again clears the message.
        const again = fixture()
        await again.player.play(keyOf('a'), reply('a'))
        expect(again.player.snapshot().error).toBeNull()
    })

    it('notes a reply that was only read in part', async () => {
        const { player } = fixture(() => new Response(new Uint8Array([1]), { headers: { 'x-rerun-speech-truncated': '1' } }))
        await player.play(keyOf('a'), reply('a'))
        expect(player.snapshot().truncated).toBe(keyOf('a'))
    })

    it('speaks a finished reply on its own once only', async () => {
        const { player, requests } = fixture()
        expect(player.autoPlay(keyOf('a'), reply('a'))).toBe(true)
        expect(player.autoPlay(keyOf('a'), reply('a'))).toBe(false)
        await Promise.resolve()
        expect(requests).toHaveLength(1)
        // The button still reads it again when asked.
        await player.play(keyOf('a'), reply('a'))
        expect(requests).toHaveLength(2)
    })
})

describe('when a finished reply is read on its own', () => {
    const ready = { enabled: true, active: true, focused: true, automated: false, armedAfter: 'engine-old' as string | null | undefined, latestSavedId: 'engine-new' as string | null }
    it('reads the new reply in the conversation on screen', () => {
        expect(desktopAutoReadTarget(ready)).toBe('engine-new')
        expect(desktopAutoReadTarget({ ...ready, armedAfter: null })).toBe('engine-new')
    })
    it.each([
        ['the switch is off', { enabled: false }],
        ['the conversation is not the one on screen', { active: false }],
        ['the app window is not focused', { focused: false }],
        ['the conversation is a routine’s run', { automated: true }],
        ['no reply just finished here', { armedAfter: undefined }],
        ['the newest saved reply is the one from before', { latestSavedId: 'engine-old' }],
        ['the reply is not saved yet', { latestSavedId: 'live-123' }],
        ['there is no reply', { latestSavedId: null }],
    ])('stays silent when %s', (_name, change) => {
        expect(desktopAutoReadTarget({ ...ready, ...change })).toBeNull()
    })
})
