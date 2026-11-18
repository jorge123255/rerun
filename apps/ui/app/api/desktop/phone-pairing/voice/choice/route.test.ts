import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'

const state = vi.hoisted(() => ({ enabled: true, voiceId: 'OldVoice1234' }))
const voices = vi.hoisted(() => vi.fn(async () => [{ id: 'OtherVoice1234', name: 'Ada', detail: 'personal labels' }]))
vi.mock('@/lib/desktop/server/database', () => ({ openDesktopDatabase: async () => ({}) }))
vi.mock('@/lib/desktop/server/auxiliary/store', () => ({ desktopAuxiliaryStore: () => ({}) }))
vi.mock('@/lib/desktop/server/voice-engine/store', () => ({ desktopVoiceEngineStore: () => ({ read: async () => state }) }))
vi.mock('@/lib/desktop/server/speech', () => ({
    desktopSpeechService: () => ({ voices }),
    readDesktopSpeechSettings: async () => ({ ...state, autoRead: true }),
    changeDesktopSpeechSettings: async (_db: unknown, picked: { voiceId: string }) => { state.voiceId = picked.voiceId },
}))
vi.mock('@/lib/desktop/server/http', () => ({
    desktopRoute: async (_request: Request, handle: (runtime: DesktopRuntime) => Promise<Response>) => {
        try { return await handle({ dataRoot: 'fixture' } as DesktopRuntime) }
        catch (error) { return new Response(null, { status: (error as { status: number }).status }) }
    },
}))
const { GET, POST } = await import('./route')
const url = 'http://127.0.0.1:3100/api/desktop/phone-pairing/voice/choice'
const save = (input: unknown) => POST(new Request(url, { method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } }))

describe('workspace voice choices for a paired phone', () => {
    beforeEach(() => { state.enabled = true; state.voiceId = 'OldVoice1234'; voices.mockClear() })

    it('returns only the selected id and names, and shares the Mac preference', async () => {
        expect(await (await GET(new Request(url))).json()).toEqual({ voiceId: state.voiceId, voices: [{ id: 'OtherVoice1234', name: 'Ada' }] })
        expect(await (await save({ voiceId: 'OtherVoice1234' })).json()).toEqual({ voiceId: 'OtherVoice1234' })
        expect((await (await GET(new Request(url))).json()).voiceId).toBe('OtherVoice1234')
    })
    it('refuses an unlisted voice, another speech setting or an inactive voice engine', async () => {
        expect((await save({ voiceId: 'x'.repeat(300) })).status).toBe(413)
        expect((await save({ voiceId: 'NotInList1234' })).status).toBe(400)
        expect((await save({ voiceId: 'OtherVoice1234', autoRead: false })).status).toBe(400)
        state.enabled = false
        voices.mockClear()
        expect((await GET(new Request(url))).status).toBe(404)
        expect((await save({ voiceId: 'OtherVoice1234' })).status).toBe(404)
        expect(voices).not.toHaveBeenCalled()
        expect(state.voiceId).toBe('OldVoice1234')
    })
})
