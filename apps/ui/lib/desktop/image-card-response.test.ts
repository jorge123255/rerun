import { expect, test } from 'vitest'
import { CARD_MAX_IMAGE_BYTES, CARD_MAX_IMAGE_TOTAL_BYTES } from '@rerun/contracts'
import { CardDisplayBudget, inspectCardImageResponse } from './image-card-response'
import { desktopFileCardOf } from './file-card'

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), char => char.charCodeAt(0))
const response = () => new Response(png, { headers: { 'content-type': 'image/png' } })

test.each(['svg', 'avif', 'ico', 'bmp'])('admits %s metadata but requires actual inert PNG output', async extension => {
    const file = { path: `files/image.${extension}`, name: `image.${extension}`, size: 100, scope: 'agent', identity: '1:2' }
    expect(desktopFileCardOf({ kind: 'file', files: [file] })?.files).toEqual([file])
    const display = await inspectCardImageResponse(response(), file.path)
    expect(display).toMatchObject({ frames: 1, pixels: 1, contentType: 'image/png' })
    expect(display.blob.size).toBe(png.length)
    await expect(inspectCardImageResponse(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }), file.path)).rejects.toThrow()
    await expect(inspectCardImageResponse(new Response('invalid', { headers: { 'content-type': 'image/png' } }), file.path)).rejects.toThrow()
})

test('rejects expanded output using actual streamed bytes and cancels the stream', async () => {
    let canceled = false
    const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(CARD_MAX_IMAGE_BYTES)); controller.enqueue(new Uint8Array(1)) },
        cancel() { canceled = true },
    })
    await expect(inspectCardImageResponse(new Response(stream, { headers: { 'content-type': 'image/png' } }), 'small.svg')).rejects.toThrow()
    expect(canceled).toBe(true)
})

test('aborting a pending body cancels and never returns display bytes', async () => {
    let canceled = false
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>({ cancel() { canceled = true } })
    const pending = inspectCardImageResponse(new Response(stream, { headers: { 'content-type': 'image/png' } }), 'x.png', controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(canceled).toBe(true)
})

test('combined display accounting bounds bytes, composited pixels and frame counts atomically', () => {
    const budget = new CardDisplayBudget()
    budget.add(CARD_MAX_IMAGE_TOTAL_BYTES, 256, 48 * 1024 * 1024)
    expect(() => budget.add(1)).toThrow()
    expect(() => budget.add(0, 1)).toThrow()
    expect(() => budget.add(0, 0, 1)).toThrow()
    expect(() => budget.add(-1)).toThrow()
    expect(() => budget.add(0)).not.toThrow()
})

test('returns the original animated GIF bytes, counts frames and refuses excessive frames', async () => {
    function gif(count: number) {
        const header = new Uint8Array([71,73,70,56,57,97,1,0,1,0,0,0,0])
        const frame = new Uint8Array([44,0,0,0,0,1,0,1,0,0,2,1,0,0])
        const bytes = new Uint8Array(header.length + count * frame.length + 1)
        bytes.set(header)
        for (let index = 0; index < count; index++) bytes.set(frame, header.length + index * frame.length)
        bytes[bytes.length - 1] = 59
        return bytes
    }
    const bytes = gif(2)
    const display = await inspectCardImageResponse(new Response(bytes, { headers: { 'content-type': 'image/gif' } }), 'animation.gif')
    expect(display.frames).toBe(2)
    expect(display.pixels).toBe(2)
    expect(new Uint8Array(await display.blob.arrayBuffer())).toEqual(bytes)
    await expect(inspectCardImageResponse(new Response(gif(257), { headers: { 'content-type': 'image/gif' } }), 'animation.gif')).rejects.toThrow()
})
