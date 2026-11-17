import { createHash } from 'node:crypto'
import { createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopHttpError } from '../auth'
import { voiceEngineApi } from './elevenlabs'
import { createVoiceEngineService } from './service'
import { desktopVoiceEngineStore } from './store'
import { API_KEY, OTHER_KEY, delay, fakeChief, fakeElevenLabsApi, fakeRelay, signSpeechEngineToken, until } from './voice.test-support'

const CHAT = { workspaceId: '1', chatId: 'fmc_conversation1' }
const TRANSCRIPT = 'Please move my dentist appointment to Friday'
const logged: string[] = []

beforeEach(() => {
    logged.length = 0
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
    }
})
afterEach(() => { vi.restoreAllMocks() })

function setup(options: { script?: Parameters<typeof fakeChief>[0] } = {}) {
    const db = createClient({ url: ':memory:' })
    const store = desktopVoiceEngineStore(db, () => Buffer.alloc(32, 7))
    const key = { current: { revision: 'rev-1', key: API_KEY } as { revision: string; key: string } | null }
    let relaySecret = ''
    let clock = Date.now()
    const elevenlabs = fakeElevenLabsApi()
    const relay = fakeRelay(() => relaySecret)
    const chief = fakeChief(options.script ?? (({ emit, end }) => {
        emit({ type: 'text', partId: 'a', delta: '**Done.** I moved it, see [the calendar](https://calendar.example.com/e/1).' })
        end()
    }))
    const service = createVoiceEngineService({
        store,
        keyInfo: async () => ({ configured: !!key.current, revision: key.current?.revision ?? 'unconfigured' }),
        readKey: async () => key.current,
        voiceId: async () => 'VoiceChosen1234',
        api: voiceEngineApi(elevenlabs.fetcher),
        chief: chief.chief,
        socket: relay.factory,
        now: () => clock,
        fillerMs: 40,
    })
    async function ready() {
        const saved = await service.saveRelay('https://voice.example.com')
        relaySecret = saved.deploy!.relaySecret
        await service.createEngine(AbortSignal.timeout(5_000))
        await service.setEnabled(true)
        await until(() => relay.open)
        await connected(service)
        return saved.deploy!
    }
    return {
        db, store, key, relay, chief, service, elevenlabs, ready,
        setSecret(value: string) { relaySecret = value },
        advance(ms: number) { clock += ms },
        now: () => clock,
    }
}

async function connected(service: ReturnType<typeof setup>['service']) {
    for (let index = 0; index < 200; index++) {
        if ((await service.status()).relayConnected) return
        await delay(5)
    }
    throw new Error('relay never connected')
}

describe('talking to the Chief of Staff from a phone, on the Mac', () => {
    it('is off and hidden until the owner sets it up: no relay connection, no ElevenLabs call, every request refused', async () => {
        const { service, relay, elevenlabs } = setup()
        expect(await service.status()).toEqual({ relayOrigin: null, enabled: false, keySaved: true, engineReady: false, engineStale: false, relayConnected: false })
        await expect(service.startConversation(CHAT, AbortSignal.timeout(1_000))).rejects.toMatchObject({ status: 404 })
        await service.saveRelay('https://voice.example.com')
        await expect(service.startConversation(CHAT, AbortSignal.timeout(1_000))).rejects.toMatchObject({ status: 404 })
        await expect(service.setEnabled(true)).resolves.toBeTruthy()
        await service.setEnabled(false)
        await delay(20)
        expect(elevenlabs.requests).toEqual([])
        await expect(service.saveRelay('http://voice.example.com')).rejects.toBeInstanceOf(DesktopHttpError)
        await expect(service.saveRelay('https://127.0.0.1')).rejects.toBeInstanceOf(DesktopHttpError)
        await expect(service.saveRelay('https://voice.example.com/path')).rejects.toBeInstanceOf(DesktopHttpError)
        service.close()
        expect(relay.connections).toBeLessThanOrEqual(1)
    })

    it('makes the engine private, without recording, pointed at the relay, with the key sent only to ElevenLabs', async () => {
        const { service, elevenlabs, ready } = setup()
        const deploy = await ready()
        const [create] = elevenlabs.requests
        expect(create.url).toBe('https://api.elevenlabs.io/v1/speech-engine')
        expect(create.headers['xi-api-key']).toBe(API_KEY)
        expect(create.body).toEqual({
            name: 'Rerun Chief of Staff',
            speech_engine: { ws_url: `wss://voice.example.com/v1/${deploy.installId}/speech-engine` },
            tts: { voice_id: 'VoiceChosen1234' },
            conversation: { max_duration_seconds: 600 },
            privacy: { record_voice: false, retention_days: 0 },
            auth: { enable_auth: true },
            cascade_timeout_seconds: 15,
        })
        expect(JSON.stringify(create.body)).not.toContain(API_KEY)
        expect(await service.status()).toMatchObject({ engineReady: true, enabled: true, relayConnected: true })
        service.close()
    })

    it('gives a phone a token for one conversation, announced to the relay first, and holds the whole conversation', async () => {
        const { service, relay, chief, ready } = setup()
        await ready()
        const grant = await service.startConversation(CHAT, AbortSignal.timeout(2_000))
        expect(Object.keys(grant).sort()).toEqual(['conversationId', 'conversationToken', 'expiresAt'])
        expect(relay.announced.has(grant.conversationId)).toBe(true)

        const call = relay.elevenlabs(signSpeechEngineToken(API_KEY))
        call.send({ type: 'init', conversation_id: grant.conversationId })
        call.send({ type: 'ping' })
        call.send({ type: 'user_transcript', user_transcript: [{ role: 'user', content: TRANSCRIPT }], event_id: 1 })
        await until(() => call.responses().some(item => item.is_final))
        expect(chief.sent).toEqual([{ chat: CHAT, requestId: expect.any(String), text: TRANSCRIPT }])
        expect(call.responses()[0]).toEqual({ type: 'pong' })
        const spoken = call.responses().filter(item => item.type === 'agent_response').map(item => item.content).join('')
        expect(spoken).toBe('Done. I moved it, see the calendar. ')
        expect(chief.replies[0]).toContain('https://calendar.example.com/e/1')
        service.close()
    })

    it('says "One moment." when the Chief of Staff is slow to start', async () => {
        const { service, relay, ready } = setup({ script: async ({ emit, end }) => { await delay(150); emit({ type: 'text', partId: 'a', delta: 'Ready now.' }); end() } })
        await ready()
        const grant = await service.startConversation(CHAT, AbortSignal.timeout(2_000))
        const call = relay.elevenlabs(signSpeechEngineToken(API_KEY))
        call.send({ type: 'init', conversation_id: grant.conversationId })
        call.send({ type: 'user_transcript', user_transcript: [{ role: 'user', content: 'Slow?' }], event_id: 1 })
        await until(() => call.responses().some(item => item.is_final))
        expect(call.responses().map(item => item.content)).toEqual(['One moment. ', 'Ready now. ', ''])
        service.close()
    })

    it.each([
        ['missing', 'not-a-token'],
        ['wrong', signSpeechEngineToken(API_KEY, { sub: 'someone_else' })],
        ['expired', signSpeechEngineToken(API_KEY, { iat: Math.floor(Date.now() / 1000) - 600, exp: Math.floor(Date.now() / 1000) - 300 })],
        ['another key', signSpeechEngineToken(OTHER_KEY)],
    ])('refuses a connection whose token is %s, before anything reaches the Chief of Staff', async (_name, authorization) => {
        const { service, relay, chief, ready } = setup()
        await ready()
        const grant = await service.startConversation(CHAT, AbortSignal.timeout(2_000))
        const call = relay.elevenlabs(authorization)
        call.send({ type: 'init', conversation_id: grant.conversationId })
        call.send({ type: 'user_transcript', user_transcript: [{ role: 'user', content: TRANSCRIPT }], event_id: 1 })
        await until(() => call.closedByMac())
        await delay(20)
        expect(chief.sent).toEqual([])
        expect(call.responses()).toEqual([])
        service.close()
    })

    it('closes an init for a conversation it did not mint, one already used, and one minted too long ago', async () => {
        const { service, relay, chief, ready, advance, now } = setup()
        await ready()
        const token = () => signSpeechEngineToken(API_KEY)
        const stranger = relay.elevenlabs(token())
        stranger.send({ type: 'init', conversation_id: 'conv_never_minted' })
        await until(() => stranger.closedByMac())

        const grant = await service.startConversation(CHAT, AbortSignal.timeout(2_000))
        const first = relay.elevenlabs(token())
        first.send({ type: 'init', conversation_id: grant.conversationId })
        const reused = relay.elevenlabs(token())
        reused.send({ type: 'init', conversation_id: grant.conversationId })
        await until(() => reused.closedByMac())
        expect(first.closedByMac()).toBe(false)

        const late = await service.startConversation(CHAT, AbortSignal.timeout(2_000))
        advance(6 * 60_000)
        const seconds = Math.floor(now() / 1000)
        const expired = relay.elevenlabs(signSpeechEngineToken(API_KEY, { iat: seconds, exp: seconds + 60 }))
        expired.send({ type: 'init', conversation_id: late.conversationId })
        await until(() => expired.closedByMac())
        // A transcript before init is refused as well.
        const early = relay.elevenlabs(token())
        early.send({ type: 'user_transcript', user_transcript: [{ role: 'user', content: TRANSCRIPT }], event_id: 1 })
        await until(() => early.closedByMac())
        expect(chief.sent).toEqual([])
        service.close()
    })

    it('does not connect with a wrong relay secret, and then refuses phones', async () => {
        const { service, relay, setSecret } = setup()
        const saved = await service.saveRelay('https://voice.example.com')
        setSecret(saved.deploy!.relaySecret.split('').reverse().join(''))
        await service.createEngine(AbortSignal.timeout(2_000))
        await service.setEnabled(true)
        await until(() => relay.refused > 0)
        expect((await service.status()).relayConnected).toBe(false)
        await expect(service.startConversation(CHAT, AbortSignal.timeout(1_000))).rejects.toMatchObject({ status: 503 })
        // Its signature is timestamped now and names this relay's path.
        const header = relay.headersSeen[0]['x-rerun-relay-auth']
        expect(Math.abs(Number(header.split('.')[1]) - Date.now() / 1000)).toBeLessThan(5)
        service.close()
    })

    it('reconnects after the relay drops it, and stops for good when turned off', async () => {
        const { service, relay, ready } = setup()
        await ready()
        relay.dropMac()
        await until(() => relay.connections >= 2 && relay.open, 4_000)
        await connected(service)
        await service.setEnabled(false)
        await delay(20)
        expect(relay.open).toBe(false)
        const count = relay.connections
        await delay(1_300)
        expect(relay.connections).toBe(count)
        service.close()
    })

    it('an engine made with another key or relay has to be made again', async () => {
        const { service, key, ready } = setup()
        await ready()
        key.current = { revision: 'rev-2', key: API_KEY }
        expect(await service.status()).toMatchObject({ engineReady: false, engineStale: true })
        await expect(service.startConversation(CHAT, AbortSignal.timeout(1_000))).rejects.toMatchObject({ status: 503 })
        key.current = null
        await expect(service.createEngine(AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'speech_no_key' })
        service.close()
    })

    it('a conversation the workspace does not hold is not found', async () => {
        const { service, ready } = setup()
        await ready()
        await expect(service.startConversation({ workspaceId: '1', chatId: 'fmc_missing0000' }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ status: 404 })
        service.close()
    })

    it('nothing logged, nothing sent to the relay and nothing given to the phone contains the key, its hash, the token or what was said', async () => {
        const { service, relay, ready, chief } = setup()
        const deploy = await ready()
        const grant = await service.startConversation(CHAT, AbortSignal.timeout(2_000))
        const jwt = signSpeechEngineToken(API_KEY)
        const call = relay.elevenlabs(jwt)
        call.send({ type: 'init', conversation_id: grant.conversationId })
        call.send({ type: 'user_transcript', user_transcript: [{ role: 'user', content: TRANSCRIPT }], event_id: 1 })
        await until(() => call.responses().some(item => item.is_final))
        expect(chief.sent).toHaveLength(1)
        const hash = createHash('sha256').update(API_KEY).digest()
        const forbidden = [API_KEY, hash.toString('hex'), hash.toString('base64'), hash.toString('base64url'), jwt, TRANSCRIPT, deploy.relaySecret]
        const sentToRelay = relay.frames.join('\n') + JSON.stringify(relay.headersSeen)
        const toPhone = JSON.stringify(grant)
        const status = JSON.stringify(await service.status())
        for (const value of forbidden) {
            expect(logged.join('\n')).not.toContain(value)
            expect(sentToRelay).not.toContain(value)
            expect(toPhone).not.toContain(value)
            expect(status).not.toContain(value)
        }
        expect(logged).toEqual([])
        service.close()
    })
})
