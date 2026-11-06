// @vitest-environment happy-dom
import { createClient } from '@libsql/client'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, useSyncExternalStore, type ButtonHTMLAttributes } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { createForemanVoiceController } from '@/lib/desktop/foreman-voice/controller'
import { createForemanVoiceClient } from '@/lib/desktop/foreman-voice/client'
import type { ForemanAudioJournal } from '@/lib/desktop/foreman-voice/journal'
import { createForemanVoiceRuntime } from '@/lib/desktop/server/foreman-voice/runtime'
import { foremanVoiceHandlers } from '@/lib/desktop/server/foreman-voice/api'
import { FOREMAN_VOICE_SCHEMA_SQL, foremanVoiceStore, voiceScope } from '@/lib/desktop/server/foreman-voice/store'
import { DESKTOP_FOREMAN_CHAT_SCHEMA } from '@/lib/desktop/server/foreman/chat-store'
import { desktopAuxiliarySchema } from '@/lib/desktop/server/auxiliary/store'
import { ForemanVoiceSlot } from './ForemanVoiceSlot'

vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }))
vi.mock('@/components/foreman/dock/ForemanPillVoice', () => ({ ForemanPillVoice: () => null }))
vi.mock('@/components/desktop/voice/DesktopVoiceWaveform', () => ({ DesktopVoiceWaveform: () => null }))
vi.mock('@rerun/ui', () => ({ TextShimmer: ({ children }: { children: string }) => <span>{children}</span> }))

const id = '00000000-0000-4000-8000-000000000001'
const target = { chat: { workspaceId: '7', chatId: 'fmc_00000000-0000-4000-8000-000000000002' }, model: { connectionId: 'saved-connection', model: 'saved-model' } }

test('a fresh loopback origin recovers its exact saved server take, plays only on request, and durably discards it', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const directory = await mkdtemp(join(tmpdir(), 'rerun-foreman-voice-restart-'))
    const url = 'file:' + join(directory, 'app.db')
    let db = createClient({ url }), root: Root | undefined, voice: ReturnType<typeof createForemanVoiceRuntime> | undefined
    const bytes = new Uint8Array([17, 29, 43, 59])
    const recorder = { start: vi.fn(async () => true), stop: vi.fn(async () => null), cancel: vi.fn(async () => {}) }
    const send = vi.fn(async () => ({ runId: id })), onAccepted = vi.fn()
    // A new origin has an empty IndexedDB journal even though the app.db belongs to the same workspace.
    const journal: ForemanAudioJournal = { read: vi.fn(async () => null), put: vi.fn(async () => {}), clear: vi.fn(async () => {}) }
    try {
        await db.executeMultiple('CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); CREATE TABLE desktop_voice_blobs(byte_length INTEGER);' + DESKTOP_FOREMAN_CHAT_SCHEMA + FOREMAN_VOICE_SCHEMA_SQL + desktopAuxiliarySchema)
        await db.execute({ sql: 'INSERT INTO desktop_foreman_chats(chat_id,workspace_id,engine_session_id) VALUES(?,?,?)', args: [target.chat.chatId, target.chat.workspaceId, 'engine-session'] })
        const recording = { attemptId: id, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, mimeType: 'audio/webm', extension: 'webm' as const, transcriptionFormat: 'webm' as const, durationMs: 1300, levels: [0.1, 0.4] }
        const saved = foremanVoiceStore(db, target, 0)
        await saved.store.reserve({ fingerprint: 'private-server-fingerprint', draft: { attemptId: id, scope: voiceScope(target), revision: id, phase: 'review', recording, transcript: null, error: null, messageId: null, updatedAt: 'saved-before-restart' } })
        await saved.blobs.put(voiceScope(target), recording, bytes, new AbortController().signal)
        db.close()
        db = createClient({ url }) // A real file-backed close/reopen, not a retained in-memory mock.
        const runtime = { protocolVersion: 1 as const, workspaceId: 7, launchNonce: 'new-boot', buildId: 'test', dataRoot: directory, app: { origin: 'http://127.0.0.1:6477', sessionToken: 's'.repeat(32) }, engine: { origin: 'http://127.0.0.1:6478', apiKey: 'private-engine-key' } }
        voice = createForemanVoiceRuntime(runtime, db, { isCurrent: () => true, shutdownSignal: new AbortController().signal, send })
        const handlers = foremanVoiceHandlers(voice), requests: Array<{ method: string; view: string | null }> = []
        const fetcher: typeof fetch = async (input, init) => {
            const address = new URL(String(input), runtime.app.origin)
            if (address.pathname !== '/api/desktop/foreman/voice') throw Error('Unexpected external request')
            const request = new Request(address, init)
            requests.push({ method: request.method, view: address.searchParams.get('view') })
            return request.method === 'POST' ? handlers.post(request) : address.searchParams.get('view') === 'pending' ? handlers.pending(request) : handlers.audio(request)
        }
        vi.stubGlobal('fetch', fetcher)
        const client = createForemanVoiceClient(fetcher)
        const controller = createForemanVoiceController(target, { recorder, journal, client, uuid: () => id, current: () => true, onAccepted })
        await controller.restore()
        expect(controller.getSnapshot()).toMatchObject({ phase: 'review', restored: true, pending: { target, attemptId: id, blob: null }, snapshot: { setup: 'transcription' } })
        expect(requests).toEqual([{ method: 'GET', view: 'pending' }])
        expect(journal.put).not.toHaveBeenCalled()
        expect(recorder.start).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(onAccepted).not.toHaveBeenCalled()
        expect(JSON.stringify(controller.getSnapshot())).not.toMatch(/private-engine-key|private-server-fingerprint|engine-session|audioBase64/)

        // Discovery never substitutes an available recording from another model/chat/workspace.
        expect((await client.recover({ ...target, model: { ...target.model, model: 'another-model' } }, new AbortController().signal)).attempt).toBeNull()
        await expect(client.recover({ ...target, chat: { ...target.chat, chatId: 'fmc_00000000-0000-4000-8000-000000000003' } }, new AbortController().signal)).rejects.toThrow()
        await expect(client.recover({ ...target, chat: { ...target.chat, workspaceId: '8' } }, new AbortController().signal)).rejects.toThrow()

        const objectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:restored-foreman')
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
        const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
        vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
        const host = document.body.appendChild(document.createElement('div'))
        root = createRoot(host)
        function RestoredSlot() {
            const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
            return <ForemanVoiceSlot voice={{ controller, view, stream: null, releasePolicy: 'review', active: true }} onOpenTranscriptionSettings={vi.fn()} />
        }
        await act(async () => root!.render(<RestoredSlot />))
        expect(requests.filter(request => request.view === 'audio')).toHaveLength(0)
        const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!
        await act(async () => { button('Play voice message').click(); await vi.waitFor(() => expect(play).toHaveBeenCalledOnce()) })
        expect(requests.filter(request => request.view === 'audio')).toHaveLength(1)
        expect(new Uint8Array(await (objectUrl.mock.calls[0][0] as Blob).arrayBuffer())).toEqual(bytes)
        await act(async () => { button('Discard').click(); await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('idle')) })
        expect(journal.clear).toHaveBeenCalledWith(id)
        expect((await foremanVoiceStore(db, target).row(id))?.bytes).toBeNull()
        expect((await client.recover(target, new AbortController().signal)).attempt).toBeNull()
        await act(async () => root!.unmount()); root = undefined
        await voice.close(); voice = undefined
        db.close(); db = createClient({ url })
        voice = createForemanVoiceRuntime({ ...runtime, launchNonce: 'third-boot' }, db, { isCurrent: () => true, shutdownSignal: new AbortController().signal, send })
        expect((await voice.pending(target, new AbortController().signal)).attempt).toBeNull()
        expect(send).not.toHaveBeenCalled(); expect(recorder.start).not.toHaveBeenCalled()
    } finally {
        if (root) await act(async () => root!.unmount())
        await voice?.close(); db.close()
        document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals()
        await rm(directory, { recursive: true, force: true })
    }
})
