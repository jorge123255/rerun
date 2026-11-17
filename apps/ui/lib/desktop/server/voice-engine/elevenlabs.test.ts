import { describe, expect, it } from 'vitest'
import { voiceEngineApi } from './elevenlabs'
import { API_KEY, OTHER_KEY, fakeElevenLabsApi } from './voice.test-support'

const input = { apiKey: API_KEY, wsUrl: 'wss://voice.example.com/v1/id/speech-engine', voiceId: 'VoiceChosen1234' }

describe('ElevenLabs engine management, against a local fake', () => {
    it('falls back to one day of retention only when no retention is refused', async () => {
        const fake = fakeElevenLabsApi({ refuseRetentionZero: true })
        expect(await voiceEngineApi(fake.fetcher).createEngine(input, AbortSignal.timeout(1_000))).toEqual({ engineId: 'seng_test0001' })
        expect(fake.requests.map(request => (request.body as { privacy: { retention_days: number } }).privacy.retention_days)).toEqual([0, 1])
    })

    it('refuses an engine that came back public or recording', async () => {
        const fake = fakeElevenLabsApi({ ignorePrivacy: true })
        await expect(voiceEngineApi(fake.fetcher).createEngine(input, AbortSignal.timeout(1_000))).rejects.toMatchObject({ status: 502 })
    })

    it('reports a refused key in the app\'s own words', async () => {
        const fake = fakeElevenLabsApi()
        await expect(voiceEngineApi(fake.fetcher).createEngine({ ...input, apiKey: OTHER_KEY }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'speech_key_refused' })
        await expect(voiceEngineApi(fake.fetcher).conversationToken({ apiKey: OTHER_KEY, engineId: 'seng_1' }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'speech_key_refused' })
    })

    it('mints a conversation token for the engine, sending the key only as its header', async () => {
        const fake = fakeElevenLabsApi()
        const grant = await voiceEngineApi(fake.fetcher).conversationToken({ apiKey: API_KEY, engineId: 'seng_test0001' }, AbortSignal.timeout(1_000))
        expect(grant).toEqual({ token: 'webrtc-token-1', conversationId: fake.minted[0] })
        expect(fake.requests[0].url).toBe('https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=seng_test0001')
        expect(fake.requests[0].url).not.toContain(API_KEY)
    })

    it('an unreachable ElevenLabs is said plainly', async () => {
        const failing = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
        await expect(voiceEngineApi(failing).conversationToken({ apiKey: API_KEY, engineId: 'seng_1' }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'speech_unreachable' })
    })
})
