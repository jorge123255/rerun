// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_VOICE_MAX_BYTES, DESKTOP_VOICE_MAX_LEVELS, MAX_RECORDING_MS } from '@rerun/contracts'
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
    timeslice: number | undefined
    listeners = new Map<string, ((event: { data: Blob }) => void)[]>()
    constructor(readonly stream: unknown, readonly options: unknown) { FakeRecorder.instances.push(this) }
    addEventListener(name: string, callback: (event: { data: Blob }) => void) {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback])
    }
    start(timeslice?: number) { this.timeslice = timeslice; this.state = 'recording' }
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
const onError = vi.fn(), onLimitReached = vi.fn()
function Probe() {
    const value = useDesktopVoiceRecorder({ onError, onLimitReached })
    useLayoutEffect(() => { api = value })
    return null
}

beforeEach(() => {
    FakeRecorder.instances = []
    const track = { stop: vi.fn() }
    stream = { getTracks: () => [track], addEventListener: vi.fn() }
    onError.mockClear(); onLimitReached.mockClear()
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
    vi.useRealTimers()
})

async function mount() {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
}

describe('desktop voice recorder boundaries', () => {
    it('hands a complete take to its owner during unmount before generic cleanup invalidates it', async () => {
        let saved!: Promise<Awaited<ReturnType<typeof api.stop>>>
        function Owner() {
            const value = useDesktopVoiceRecorder({ onError, onLimitReached, onDispose: () => { saved = api.stop(); return true } })
            useLayoutEffect(() => { api = value })
            return null
        }
        root = createRoot(document.body.appendChild(document.createElement('div')))
        await act(async () => root!.render(<Owner />))
        await act(async () => { await api.start() })
        FakeRecorder.instances[0]!.emit(new Blob(['complete voice bytes']))
        await act(async () => root!.unmount())
        root = undefined
        expect((await saved)?.blob.size).toBeGreaterThan(0)
        expect(stream.getTracks()[0]!.stop).toHaveBeenCalled()
    })
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

    it('requests bounded chunks and refuses an incomplete over-limit container', async () => {
        await mount()
        await act(async () => { expect(await api.start()).toBe(true) })
        const recorder = FakeRecorder.instances[0]!
        expect(FakeRecorder.instances.every(take => take.timeslice === 250)).toBe(true)
        await act(async () => {
            recorder.emit(new Blob(['x']))
            recorder.emit(new Blob([new Uint8Array(DESKTOP_VOICE_MAX_BYTES + 1)]))
        })
        const take = await act(async () => api.stop())
        expect(take).toBeNull()
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('incomplete audio was not saved'))
        expect(stream.getTracks()[0]!.stop).toHaveBeenCalled()

        await act(async () => { expect(await api.start()).toBe(true) })
        expect(await act(async () => api.stop())).toBeNull()
    })

    it.each(['recorder', 'audio context'] as const)('releases an acquired microphone when the %s constructor fails', async failure => {
        const Broken = class { constructor() { throw new Error('fixture startup failure') } }
        vi.stubGlobal(failure === 'recorder' ? 'MediaRecorder' : 'AudioContext', Broken)
        await mount()
        await act(async () => { expect(await api.start()).toBe(false) })
        expect(stream.getTracks()[0]!.stop).toHaveBeenCalledTimes(1)
        expect(api.stream).toBeNull()
        expect(api.status).toBe('idle')
    })

    it('clamps a late timer tick and freezes capture metadata before recorder settling', async () => {
        vi.useFakeTimers()
        const began = new Date('2026-11-05T00:00:00Z')
        vi.setSystemTime(began)
        await mount()
        await act(async () => { expect(await api.start()).toBe(true) })
        FakeRecorder.instances[0]!.emit(new Blob(['complete fixture']))
        vi.setSystemTime(new Date(began.getTime() + MAX_RECORDING_MS + 137))
        await act(async () => { await vi.advanceTimersByTimeAsync(50) })
        expect(onLimitReached).toHaveBeenCalledTimes(1)
        expect(stream.getTracks()[0]!.stop).toHaveBeenCalled()
        const take = await act(async () => api.stop())
        expect(take?.durationMs).toBe(MAX_RECORDING_MS)
        expect(take!.levels.length).toBeLessThanOrEqual(DESKTOP_VOICE_MAX_LEVELS)
        const levels = take!.levels.slice()
        await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
        expect(take!.levels).toEqual(levels)
    })
})
