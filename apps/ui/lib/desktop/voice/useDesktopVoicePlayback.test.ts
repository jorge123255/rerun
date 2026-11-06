import { expect, test, vi } from 'vitest'
import { DESKTOP_VOICE_MAX_BYTES } from '@rerun/contracts'
import { readDesktopVoiceAudio } from './useDesktopVoicePlayback'

test('playback rejects an oversized declared body before consuming it', async () => {
    const cancel = vi.fn(), pull = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
    const response = new Response(stream, { headers: { 'content-type': 'audio/webm', 'content-length': String(DESKTOP_VOICE_MAX_BYTES + 1) } })
    await expect(readDesktopVoiceAudio(response, new AbortController().signal)).rejects.toThrow(/damaged/)
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
})

test('playback stops a chunked response as soon as its accumulated bytes exceed 2 MB', async () => {
    const cancel = vi.fn()
    let chunks = 0
    const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel }, { highWaterMark: 0 }), { headers: { 'content-type': 'audio/webm' } })
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer')
    await expect(readDesktopVoiceAudio(response, new AbortController().signal)).rejects.toThrow(/damaged/)
    expect(chunks).toBe(3)
    expect(cancel).toHaveBeenCalledOnce()
    expect(arrayBuffer).not.toHaveBeenCalled()
})

test('playback accepts bounded audio and rejects a truncated declared body', async () => {
    const signal = new AbortController().signal
    expect((await readDesktopVoiceAudio(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/webm', 'content-length': '3' } }), signal)).size).toBe(3)
    await expect(readDesktopVoiceAudio(new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/webm', 'content-length': '3' } }), signal)).rejects.toThrow(/incomplete/)
})
