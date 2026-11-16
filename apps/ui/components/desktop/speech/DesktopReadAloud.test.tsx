// @vitest-environment happy-dom
import type { UIMessage } from 'ai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DESKTOP_SPEECH_DEFAULT_VOICE } from '@/lib/desktop/speech'
import { announceDesktopSpeechChange, createDesktopSpeechPlayer, desktopForemanSpeechScope, desktopSpeechKey, desktopSpeechPlayer } from '@/lib/desktop/speech-player'
import { DesktopAssistantReply } from '../DesktopAssistantReply'
import { DesktopAuxiliarySettings } from '../DesktopAuxiliarySettings'
import { DesktopForemanAnswerActions } from '../foreman/DesktopForemanAnswerActions'
import { DesktopReadAloud } from './DesktopReadAloud'
import { useDesktopSpokenReplies } from './useDesktopSpokenReplies'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agentId = '6f1b6a0e-6a52-4f0b-9d5e-0c1f8f0e1a11', sessionId = '6f1b6a0e-6a52-4f0b-9d5e-0c1f8f0e1a12'
let container: HTMLDivElement
let root: Root
beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    announceDesktopSpeechChange()
})
afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})
const settle = () => act(async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve() })
const parts: UIMessage['parts'] = [{ type: 'text', text: 'The **answer**.' }]
const action = () => container.querySelector<HTMLButtonElement>('button[data-read-aloud]')

function fakePlayer() {
    const requests: unknown[] = [], sounds: { playing: boolean }[] = []
    const player = createDesktopSpeechPlayer({
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => { requests.push(JSON.parse(String(init?.body))); return new Response(new Uint8Array([1])) }) as typeof fetch,
        sound: () => { const sound = { playing: false, onended: null, onerror: null, play: async () => { sound.playing = true }, pause: () => { sound.playing = false } }; sounds.push(sound); return sound },
        objectUrl: () => 'blob:test', revoke: () => {},
    })
    return { player, requests, sounds }
}

test('a reply offers Read aloud only when an ElevenLabs key is saved', async () => {
    const reply = (readAloud?: { sessionId: string }, id = 'engine-msg-1', streaming = false) =>
        act(async () => root.render(<DesktopAssistantReply message={{ id, role: 'assistant', parts }} streaming={streaming} agentId={agentId} readAloud={readAloud} />))
    await reply(undefined)
    expect(container.querySelector('button[aria-label="Copy reply"]')).not.toBeNull()
    expect(action()).toBeNull()
    await reply({ sessionId })
    expect(action()?.getAttribute('aria-label')).toBe('Read aloud')
    expect(action()?.dataset.readAloud).toBe('idle')
    // Not while the reply is still arriving, and not for a reply that is not saved yet.
    await reply({ sessionId }, 'engine-msg-1', true)
    expect(action()).toBeNull()
    await reply({ sessionId }, 'live-reply')
    expect(action()).toBeNull()
})

test('the action plays, shows Stop while playing, and moves when another reply starts', async () => {
    const { player, requests, sounds } = fakePlayer()
    await act(async () => root.render(<div>
        <div id="one"><DesktopReadAloud agentId={agentId} sessionId={sessionId} messageId="engine-one" player={player} /></div>
        <div id="two"><DesktopReadAloud agentId={agentId} sessionId={sessionId} messageId="engine-two" player={player} /></div>
    </div>))
    const button = (id: string) => container.querySelector<HTMLButtonElement>(`#${id} button[data-read-aloud]`)!
    await act(async () => button('one').click())
    await settle()
    expect(requests).toEqual([{ agentId, sessionId, messageId: 'engine-one' }])
    expect(button('one').getAttribute('aria-label')).toBe('Stop reading')
    expect(button('one').getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('#one [role="status"]')?.textContent).toBe('Reading aloud…')
    expect(button('two').getAttribute('aria-label')).toBe('Read aloud')
    await act(async () => button('two').click())
    await settle()
    expect(button('one').getAttribute('aria-label')).toBe('Read aloud')
    expect(button('two').getAttribute('aria-label')).toBe('Stop reading')
    expect(sounds.map(sound => sound.playing)).toEqual([false, true])
    await act(async () => button('two').click())
    expect(button('two').getAttribute('aria-label')).toBe('Read aloud')
    expect(sounds[1].playing).toBe(false)
    expect(requests).toHaveLength(2)
})

test('a failure is a plain message on the reply’s action', async () => {
    const player = createDesktopSpeechPlayer({
        fetch: (async () => Response.json({ code: 'speech_key_refused', error: 'ElevenLabs refused the saved key. Check it in Settings, under Tool services.' }, { status: 502 })) as typeof fetch,
        sound: () => { throw new Error('never played') }, objectUrl: () => 'blob:test', revoke: () => {},
    })
    await act(async () => root.render(<DesktopReadAloud agentId={agentId} sessionId={sessionId} messageId="engine-one" player={player} />))
    await act(async () => action()!.click())
    await settle()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('ElevenLabs refused the saved key. Check it in Settings, under Tool services.')
    expect(action()?.getAttribute('aria-label')).toBe('Read aloud')
})

test('a Chief of Staff answer offers Read aloud only when given it, and names the answer by its conversation', async () => {
    const { player, requests } = fakePlayer()
    const chat = { workspaceId: 'workspace-1', chatId: 'chat-1' }
    const answer = (readAloud: boolean) => act(async () => root.render(<DesktopForemanAnswerActions copyText="An answer" onRate={() => {}}
        readAloud={readAloud ? <DesktopReadAloud agentId={desktopForemanSpeechScope(chat.workspaceId)} sessionId={chat.chatId} messageId="engine-a1" foreman={chat} player={player} /> : undefined} />))
    await answer(false)
    expect(container.querySelectorAll('button')).toHaveLength(3)
    expect(action()).toBeNull()
    await answer(true)
    expect(container.querySelectorAll('button')).toHaveLength(4)
    await act(async () => action()!.click())
    await settle()
    expect(requests).toEqual([{ foreman: chat, messageId: 'engine-a1' }])
    expect(action()?.getAttribute('aria-label')).toBe('Stop reading')
    player.stopWithin(desktopSpeechKey(desktopForemanSpeechScope('workspace-1'), 'chat-1', ''))
    expect(player.snapshot().key).toBeNull()
})

function Watch(props: Omit<Parameters<typeof useDesktopSpokenReplies>[0], 'agentId'>) {
    const { available } = useDesktopSpokenReplies({ agentId, ...props })
    return <p data-available={String(available)} />
}
const settingsFetch = (settings: { configured: boolean; autoRead: boolean }) => vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...settings, voiceId: DESKTOP_SPEECH_DEFAULT_VOICE.id })))

test('a new reply is read once when it finishes, only with the switch on, a focused window and a person’s own conversation', async () => {
    settingsFetch({ configured: true, autoRead: true })
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { player, requests } = fakePlayer()
    const show = (props: Partial<Parameters<typeof Watch>[0]>) => act(async () => root.render(<Watch sessionId={sessionId} liveSessionId={sessionId} active streaming={false} automated={false} latestSavedId="engine-old" player={player} {...props} />))
    await show({})
    await settle()
    expect(container.querySelector('p')?.dataset.available).toBe('true')
    expect(requests).toEqual([])
    // A reply arrives: nothing while it streams, nothing until its saved copy is read back, then once.
    await show({ streaming: true, latestSavedId: null })
    await show({ streaming: false, latestSavedId: 'engine-old' })
    expect(requests).toEqual([])
    await show({ latestSavedId: 'engine-new' })
    await settle()
    expect(requests).toEqual([{ agentId, sessionId, messageId: 'engine-new' }])
    await show({ latestSavedId: 'engine-new', active: false })
    await show({ latestSavedId: 'engine-new' })
    await settle()
    expect(requests).toHaveLength(1)
    // A routine's run is never read.
    await show({ streaming: true, latestSavedId: null, automated: true })
    await show({ latestSavedId: 'engine-routine', automated: true })
    await settle()
    expect(requests).toHaveLength(1)
    // Nor a reply that finished while the app was in the background, even after the window comes back.
    focus.mockReturnValue(false)
    await show({ streaming: true, latestSavedId: null })
    await show({ latestSavedId: 'engine-background' })
    focus.mockReturnValue(true)
    await show({ latestSavedId: 'engine-background', liveSessionId: null })
    await settle()
    expect(requests).toHaveLength(1)
    // Opening another conversation reads nothing from it.
    await show({ sessionId: '6f1b6a0e-6a52-4f0b-9d5e-0c1f8f0e1a13', latestSavedId: 'engine-elsewhere' })
    await settle()
    expect(requests).toHaveLength(1)
})

test('nothing is read on its own while the switch is off, and leaving the conversation stops the voice', async () => {
    settingsFetch({ configured: true, autoRead: false })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { player, requests, sounds } = fakePlayer()
    const show = (props: Partial<Parameters<typeof Watch>[0]>) => act(async () => root.render(<Watch sessionId={sessionId} liveSessionId={sessionId} active streaming={false} automated={false} latestSavedId="engine-old" player={player} {...props} />))
    await show({})
    await settle()
    await show({ streaming: true, latestSavedId: null })
    await show({ latestSavedId: 'engine-new' })
    await settle()
    expect(requests).toEqual([])
    await act(async () => { await player.play(desktopSpeechKey(agentId, sessionId, 'engine-new'), { agentId, sessionId, messageId: 'engine-new' }) })
    expect(sounds[0].playing).toBe(true)
    await show({ sessionId: '6f1b6a0e-6a52-4f0b-9d5e-0c1f8f0e1a13', latestSavedId: null })
    expect(sounds[0].playing).toBe(false)
    expect(player.snapshot()).toMatchObject({ key: null, phase: 'idle' })
})

test('replies offer nothing to read aloud when no key is saved', async () => {
    settingsFetch({ configured: false, autoRead: true })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { player, requests } = fakePlayer()
    const show = (props: Partial<Parameters<typeof Watch>[0]>) => act(async () => root.render(<Watch sessionId={sessionId} liveSessionId={sessionId} active streaming={false} automated={false} latestSavedId="engine-old" player={player} {...props} />))
    await show({})
    await settle()
    expect(container.querySelector('p')?.dataset.available).toBe('false')
    await show({ streaming: true, latestSavedId: null })
    await show({ latestSavedId: 'engine-new' })
    await settle()
    expect(requests).toEqual([])
})

test('Settings names one ElevenLabs key for both directions and shows the voice controls only once a key is saved', async () => {
    const rows = (configured: boolean) => ['search', 'keirolabs-search', 'browser-use-search', 'keenable-search', 'embedding', 'local-embedding', 'transcription', 'elevenlabs-transcription']
        .map(purpose => ({ purpose, revision: purpose === 'elevenlabs-transcription' && configured ? 'rev-1' : 'unconfigured', configured: purpose === 'elevenlabs-transcription' && configured }))
    let configured = false
    const changes: unknown[] = []
    let speech = { configured: true, voiceId: DESKTOP_SPEECH_DEFAULT_VOICE.id, autoRead: false }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/desktop/auxiliary') return Response.json(rows(configured))
        if (url === '/api/desktop/speech/voices') return Response.json({ voices: [{ id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', detail: 'american, female' }] })
        if (url === '/api/desktop/speech') {
            if (init?.method === 'PUT') { const change = JSON.parse(String(init.body)); changes.push(change); speech = { ...speech, ...change } }
            return Response.json(speech)
        }
        return Response.json({ running: false, models: [], embeddingModels: [] })
    }))
    await act(async () => root.render(<DesktopAuxiliarySettings />))
    await settle()
    expect([...container.querySelectorAll('h2')].map(node => node.textContent)).toContain('Voice with ElevenLabs')
    expect(container.textContent).toContain('One key for both directions')
    expect(container.querySelector('[data-speech-settings]')).toBeNull()
    await act(async () => root.unmount())
    configured = true
    root = createRoot(container)
    await act(async () => root.render(<DesktopAuxiliarySettings />))
    await settle()
    const panel = container.querySelector<HTMLElement>('[data-speech-settings]')!
    expect(panel.textContent).toContain('is sent to ElevenLabs and billed to your ElevenLabs account')
    const select = panel.querySelector<HTMLSelectElement>('select#speech-voice')!
    expect([...select.options].map(option => option.textContent)).toEqual(['George (default)', 'Sarah (american, female)'])
    expect([...panel.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Preview'])
    const auto = panel.querySelector<HTMLInputElement>('input[role="switch"]')!
    expect(auto.checked).toBe(false)
    expect(panel.textContent).toContain('Read replies aloud automatically')
    await act(async () => auto.click())
    await settle()
    expect(changes).toEqual([{ autoRead: true }])
    expect(panel.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true)
    expect(container.querySelector('input[type="password"]#tool-service-elevenlabs-transcription')?.getAttribute('value')).toBe('')
    desktopSpeechPlayer.stop()
})
