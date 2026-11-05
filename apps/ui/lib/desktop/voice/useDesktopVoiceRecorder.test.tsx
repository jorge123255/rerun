// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_VOICE_MAX_BYTES } from '../../../../../packages/contracts/src/desktop-voice.ts'
import { useDesktopVoiceRecorder } from './useDesktopVoiceRecorder'

const { format, backup } = vi.hoisted(() => ({
    format: { mimeType: 'audio/webm;codecs=opus', extension: 'webm', transcriptionFormat: 'webm' },
    backup: { mimeType: 'audio/webm', extension: 'webm', transcriptionFormat: 'webm' },
}))
vi.mock('@/lib/voice/recording', () => ({
    MAX_RECORDING_MS: 300_000,
    RECORDING_BITS_PER_SECOND: 32_000,
    pickRecordingFormat: () => format,
    pickBackupFormat: () => backup,
    markRecordingFormatBroken: vi.fn(),
}))

class FakeRecorder {
    static instances: FakeRecorder[] = []
    state = 'inactive'
    listeners = new Map<string, ((event: { data: Blob }) => void)[]>()
    constructor(readonly stream: unknown, readonly options: unknown) { FakeRecorder.instances.push(this) }
    addEventListener(name: string, callback: (event: { data: Blob }) => void) {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback])
    }
    start() { this.state = 'recording' }
    stop() {
        this.state = 'inactive'
        for (const callback of this.listeners.get('stop') ?? []) callback({ data: new Blob() })
    }
    emit(data: Blob) {
        for (const callback of this.listeners.get('dataavailable') ?? []) callback({ data })
    }
}

let root: Root | undefined
let stream: { getTracks: () => { stop: ReturnType<typeof vi.fn> }[]; addEventListener: ReturnType<typeof vi.fn> }
let api: ReturnType<typeof useDesktopVoiceRecorder>
function Probe() {
    api = useDesktopVoiceRecorder({ onError: vi.fn(), onLimitReached: vi.fn() })
    return null
}

beforeEach(() => {
    FakeRecorder.instances = []
    stream = { getTracks: () => [{ stop: vi.fn() }], addEventListener: vi.fn() }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.stubGlobal('AudioContext', class {
        createAnalyser() { return { fftSize: 1024, getByteTimeDomainData: () => {}, disconnect: vi.fn() } }
        createMediaStreamSource() { return { connect: vi.fn() } }
        resume() { return Promise.resolve() }
        close() { return Promise.resolve() }
    })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } })
})

afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

async function mount() {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
}

describe('desktop voice recorder boundaries', () => {
    it('reports denied permission without starting a recorder', async () => {
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError') }) } })
        await mount()
        await act(async () => { expect(await api.start()).toBe(false) })
        expect(FakeRecorder.instances).toHaveLength(0)
    })

    it('stops a late-granted stream after cancellation instead of auto-starting', async () => {
        let grant!: (value: typeof stream) => void
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise(resolve => { grant = resolve }) } })
        await mount()
        const starting = api.start()
        await act(async () => { api.cancel(); grant(stream); await starting })
        expect(FakeRecorder.instances).toHaveLength(0)
        expect(stream.getTracks()[0]!.stop).toHaveBeenCalled()
    })

    it('uses the backup take when the primary produces no bytes and releases hardware', async () => {
        await mount()
        await act(async () => { expect(await api.start()).toBe(true) })
        const [primary, secondary] = FakeRecorder.instances
        await act(async () => {
            secondary!.emit(new Blob(['x']))
            primary!.stop()
            secondary!.stop()
        })
        const take = await act(async () => api.stop())
        expect(take?.format).toEqual(backup)
        expect(stream.getTracks()[0]!.stop).toHaveBeenCalled()
    })

    it('keeps bounded partial audio at the byte cap and returns null for empty audio', async () => {
        await mount()
        await act(async () => { expect(await api.start()).toBe(true) })
        const recorder = FakeRecorder.instances[0]!
        await act(async () => {
            recorder.emit(new Blob(['x']))
            recorder.emit(new Blob([new Uint8Array(DESKTOP_VOICE_MAX_BYTES + 1)]))
        })
        const take = await act(async () => api.stop())
        expect(take?.limited).toBe(true)
        expect(take?.blob.size).toBe(1)

        await act(async () => { expect(await api.start()).toBe(true) })
        expect(await act(async () => api.stop())).toBeNull()
    })
})
