import { CARD_MAX_AUDIO_BYTES, CARD_MAX_FILES, CARD_MAX_IMAGE_BYTES, CARD_MAX_IMAGE_TOTAL_BYTES, CARD_MAX_VIDEO_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES } from '@rerun/contracts'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopCardError, desktopFileCardOf, readDesktopCardAudio, readDesktopCardFile, readDesktopCardImage, readDesktopCardVideo } from './file-card'

afterEach(() => vi.unstubAllGlobals())

const file = (over: Record<string, unknown> = {}) => ({ path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent', ...over })
const image = (over: Record<string, unknown> = {}) => ({ path: 'shots/photo.png', name: 'photo.png', size: 1024, scope: 'agent', identity: '12:34', ...over })
const audio = (over: Record<string, unknown> = {}) => ({ path: 'voice/tone.wav', name: 'tone.wav', size: 1024, scope: 'agent', identity: '12:34', ...over })
const video = (over: Record<string, unknown> = {}) => ({ path: 'shots/clip.mp4', name: 'clip.mp4', size: 1024, scope: 'agent', identity: '12:35', ...over })
const card = (files: unknown[] = [file()]) => ({ kind: 'file', files })

test('accepts the tool output, a stored wrapper and the legacy single-file card', () => {
    const expected = { kind: 'file', files: [{ path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' }] }
    expect(desktopFileCardOf(card())).toEqual(expected)
    expect(desktopFileCardOf(JSON.stringify(card()))).toEqual(expected)
    expect(desktopFileCardOf({ type: 'text', value: JSON.stringify(card()) })).toEqual(expected)
    expect(desktopFileCardOf({ type: 'json', value: card() })).toEqual(expected)
    expect(desktopFileCardOf({ kind: 'file', path: 'reports/summary.md', name: 'summary.md', size: 7 })).toEqual(expected)
})

test('keeps only the path metadata the tiles need', () => {
    expect(desktopFileCardOf({ ...card([file({ token: 'private' })]), extra: 'private', url: 'https://outside.invalid/x' })).toEqual({
        kind: 'file', files: [{ path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' }],
    })
})

test('keeps the endpoint identity for images, audio and video, and preserves a text card without one', () => {
    expect(desktopFileCardOf(card([image()]))).toEqual({
        kind: 'file', files: [{ path: 'shots/photo.png', name: 'photo.png', size: 1024, scope: 'agent', identity: '12:34' }],
    })
    expect(desktopFileCardOf(card([audio({ path: 'voice/tone.mp3', name: 'tone.mp3' })]))).toEqual({
        kind: 'file', files: [{ path: 'voice/tone.mp3', name: 'tone.mp3', size: 1024, scope: 'agent', identity: '12:34' }],
    })
    expect(desktopFileCardOf(card([video()]))).toEqual({
        kind: 'file', files: [{ path: 'shots/clip.mp4', name: 'clip.mp4', size: 1024, scope: 'agent', identity: '12:35' }],
    })
    expect(desktopFileCardOf(card([file(), image(), audio(), video()]))).toEqual({
        kind: 'file', files: [
            { path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' },
            { path: 'shots/photo.png', name: 'photo.png', size: 1024, scope: 'agent', identity: '12:34' },
            { path: 'voice/tone.wav', name: 'tone.wav', size: 1024, scope: 'agent', identity: '12:34' },
            { path: 'shots/clip.mp4', name: 'clip.mp4', size: 1024, scope: 'agent', identity: '12:35' },
        ],
    })
})

test.each([
    ['a shared file', card([file({ scope: 'shared' })])],
    ['a shared image', card([image({ scope: 'shared' })])],
    ['a shared audio file', card([audio({ scope: 'shared' })])],
    ['a shared video file', card([video({ scope: 'shared' })])],
    ['an absolute path', card([file({ path: '/tmp/summary.md' })])],
    ['an absolute image path', card([image({ path: '/tmp/photo.png', name: 'photo.png' })])],
    ['an absolute audio path', card([audio({ path: '/tmp/tone.wav', name: 'tone.wav' })])],
    ['an absolute video path', card([video({ path: '/tmp/clip.mp4', name: 'clip.mp4' })])],
    ['traversal', card([file({ path: '../summary.md' })])],
    ['a hidden segment', card([file({ path: '.secret/summary.md' })])],
    ['a hidden image segment', card([image({ path: '.secret/photo.png', name: 'photo.png' })])],
    ['a hidden audio segment', card([audio({ path: '.secret/tone.wav', name: 'tone.wav' })])],
    ['a hidden video segment', card([video({ path: '.secret/clip.mp4', name: 'clip.mp4' })])],
    ['a backslash', card([file({ path: 'reports\\summary.md' })])],
    ['an unsupported document', card([file({ path: 'reports/image.svg', name: 'image.svg' })])],
    ['an unsupported image', card([image({ path: 'shots/photo.avif', name: 'photo.avif' })])],
    ['an unsupported video', card([video({ path: 'shots/clip.mov', name: 'clip.mov' })])],
    ['a webm video', card([video({ path: 'shots/clip.webm', name: 'clip.webm' })])],
    ['a pdf', card([image({ path: 'shots/deck.pdf', name: 'deck.pdf' })])],
    ['an unsupported OGG audio', card([audio({ path: 'voice/tone.ogg', name: 'tone.ogg' })])],
    ['an unsupported M4A audio', card([audio({ path: 'voice/tone.m4a', name: 'tone.m4a' })])],
    ['an unsupported FLAC audio', card([audio({ path: 'voice/tone.flac', name: 'tone.flac' })])],
    ['a mismatched name', card([file({ name: 'other.md' })])],
    ['a mismatched image name', card([image({ name: 'other.png' })])],
    ['a mismatched audio name', card([audio({ name: 'other.wav' })])],
    ['a mismatched video name', card([video({ name: 'other.mp4' })])],
    ['a negative size', card([file({ size: -1 })])],
    ['a NaN size', card([file({ size: Number.NaN })])],
    ['an infinite size', card([file({ size: Number.POSITIVE_INFINITY })])],
    ['an oversized text file', card([file({ size: DESKTOP_ATTACHMENT_MAX_BYTES + 1 })])],
    ['an oversized image', card([image({ size: CARD_MAX_IMAGE_BYTES + 1 })])],
    ['an oversized video', card([video({ size: CARD_MAX_VIDEO_BYTES + 1 })])],
    ['an oversized audio file', card([audio({ size: CARD_MAX_AUDIO_BYTES + 1 })])],
    ['an empty image', card([image({ size: 0 })])],
    ['an empty video', card([video({ size: 0 })])],
    ['an empty audio file', card([audio({ size: 0 })])],
    ['an image without identity', card([image({ identity: undefined })])],
    ['a video without identity', card([video({ identity: undefined })])],
    ['an audio file without identity', card([audio({ identity: undefined })])],
    ['an image with malformed identity', card([image({ identity: 'not-an-inode' })])],
    ['a video with malformed identity', card([video({ identity: 'not-an-inode' })])],
    ['an audio file with malformed identity', card([audio({ identity: 'not-an-inode' })])],
    ['an empty card', { kind: 'file', files: [] }],
    ['too many files', card(Array.from({ length: CARD_MAX_FILES + 1 }, (_, index) => file({ path: `reports/${index}.md`, name: `${index}.md` })))],
    ['prose', 'Could not show that file, nothing was shown.'],
    ['malformed JSON', '{"kind":"file"'],
    ['an error wrapper', { type: 'text', value: 'Could not show that file, nothing was shown.' }],
])('rejects %s rather than drawing a partial or invented card', (_name, value) => {
    expect(desktopFileCardOf(value)).toBeUndefined()
})

test('bounds the text edge, image edge, video edge and aggregate media preview budget', () => {
    const files = Array.from({ length: CARD_MAX_FILES }, (_, index) => file({ path: `reports/${index}.md`, name: `${index}.md` }))
    expect(desktopFileCardOf(card(files))?.files).toHaveLength(CARD_MAX_FILES)
    expect(desktopFileCardOf(card([file({ size: DESKTOP_ATTACHMENT_MAX_BYTES })]))?.files[0].size).toBe(DESKTOP_ATTACHMENT_MAX_BYTES)
    expect(desktopFileCardOf(card([image({ size: CARD_MAX_IMAGE_BYTES })]))?.files[0].size).toBe(CARD_MAX_IMAGE_BYTES)
    expect(desktopFileCardOf(card([video({ size: CARD_MAX_VIDEO_BYTES })]))?.files[0].size).toBe(CARD_MAX_VIDEO_BYTES)
    expect(desktopFileCardOf(card([audio({ size: CARD_MAX_AUDIO_BYTES })]))?.files[0].size).toBe(CARD_MAX_AUDIO_BYTES)
    const withinBudget = Array.from({ length: 3 }, (_, index) => image({ path: `shots/${index}.webp`, name: `${index}.webp`, size: CARD_MAX_IMAGE_BYTES }))
    expect(desktopFileCardOf(card(withinBudget))?.files).toHaveLength(3)
    const overBudget = [...withinBudget, image({ path: 'shots/extra.gif', name: 'extra.gif', size: 1 })]
    expect(desktopFileCardOf(card(overBudget))).toBeUndefined()
    // Video is charged to the same combined budget as images.
    expect(desktopFileCardOf(card([...withinBudget, video({ size: 1 })]))).toBeUndefined()
    // Two full-size videos fit; images and videos share the same ceiling.
    expect(desktopFileCardOf(card([image({ size: CARD_MAX_IMAGE_BYTES }), video({ size: CARD_MAX_VIDEO_BYTES })]))?.files).toHaveLength(2)
    const ten = 10 * 1024 * 1024
    expect(desktopFileCardOf(card([
        video({ size: ten }), video({ path: 'shots/other.mp4', name: 'other.mp4', size: ten }), image({ size: CARD_MAX_IMAGE_BYTES }),
    ]))).toBeUndefined()
    // Audio is not part of the combined image-and-video budget.
    expect(desktopFileCardOf(card([...withinBudget, audio()]))?.files).toHaveLength(4)
    expect(CARD_MAX_IMAGE_TOTAL_BYTES).toBe(CARD_MAX_IMAGE_BYTES * 3)
})

test('reads a card file through the authenticated desktop files route', async () => {
    const fetch = vi.fn(async () => Response.json({ content: '# Current', truncated: false }))
    vi.stubGlobal('fetch', fetch)
    await expect(readDesktopCardFile('agent 1', 'reports/summary.md')).resolves.toEqual({ content: '# Current', truncated: false })
    expect(fetch).toHaveBeenCalledWith('/api/desktop/agents/agent%201/files/read?path=reports%2Fsummary.md', { cache: 'no-store' })
})

test('reads an image with its identity through the authenticated desktop image route', async () => {
    const fetch = vi.fn(async () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetch)
    const result = await readDesktopCardImage('agent-1', 'shots/photo.png', '12:34')
    expect(result.contentType).toBe('image/png')
    expect([...new Uint8Array(await result.blob.arrayBuffer())]).toEqual([1, 2, 3])
    expect(fetch).toHaveBeenCalledWith('/api/desktop/agents/agent-1/files/image?path=shots%2Fphoto.png&identity=12%3A34', { cache: 'no-store' })
})

test('reports a deleted, replaced or invalid image instead of returning stale bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: '“photo.png” was renamed or replaced. It was left unchanged.' }, { status: 409 })))
    await expect(readDesktopCardImage('agent-1', 'shots/photo.png', '12:34')).rejects.toThrow(DesktopCardError)
    await expect(readDesktopCardImage('agent-1', 'shots/photo.png', '12:34')).rejects.toThrow('renamed or replaced')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ content: { hidden: 'not text' } })))
    await expect(readDesktopCardFile('agent-1', 'reports/summary.md')).rejects.toThrow('no longer available')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not an image', { headers: { 'content-type': 'text/plain' } })))
    await expect(readDesktopCardImage('agent-1', 'shots/photo.png', '12:34')).rejects.toThrow('can’t be displayed')
    await expect(readDesktopCardImage('agent-1', 'shots/photo.png', undefined)).rejects.toThrow('Send this image')
})


test('reads a card audio file with its identity through the authenticated desktop audio route', async () => {
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46])
    const fetch = vi.fn(async () => new Response(new Blob([bytes], { type: 'audio/wav' }), { headers: { 'content-type': 'audio/wav' } }))
    vi.stubGlobal('fetch', fetch)
    const result = await readDesktopCardAudio('agent-1', 'voice/tone.wav', '12:34')
    expect(result.contentType).toBe('audio/wav')
    expect([...new Uint8Array(await result.blob.arrayBuffer())]).toEqual([...bytes])
    expect(fetch).toHaveBeenCalledWith('/api/desktop/agents/agent-1/files/audio?path=voice%2Ftone.wav&identity=12%3A34', { cache: 'no-store' })
})

test('reports missing, replaced or invalid audio without returning stale bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: '“tone.wav” was renamed or replaced. It was left unchanged.' }, { status: 409 })))
    await expect(readDesktopCardAudio('agent-1', 'voice/tone.wav', '12:34')).rejects.toThrow(DesktopCardError)
    await expect(readDesktopCardAudio('agent-1', 'voice/tone.wav', '12:34')).rejects.toThrow('renamed or replaced')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not audio', { headers: { 'content-type': 'text/plain' } })))
    await expect(readDesktopCardAudio('agent-1', 'voice/tone.wav', '12:34')).rejects.toThrow('can’t be played')
    await expect(readDesktopCardAudio('agent-1', 'voice/tone.wav', undefined)).rejects.toThrow('Send this audio')
})

test('reads a card video with its identity through the authenticated desktop video route', async () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])
    const fetch = vi.fn(async () => new Response(new Blob([bytes], { type: 'video/mp4' }), { headers: { 'content-type': 'video/mp4' } }))
    vi.stubGlobal('fetch', fetch)
    const result = await readDesktopCardVideo('agent-1', 'shots/clip.mp4', '12:35')
    expect(result.contentType).toBe('video/mp4')
    expect([...new Uint8Array(await result.blob.arrayBuffer())]).toEqual([...bytes])
    expect(fetch).toHaveBeenCalledWith('/api/desktop/agents/agent-1/files/video?path=shots%2Fclip.mp4&identity=12%3A35', { cache: 'no-store' })
})

test('reports missing, replaced or invalid video without returning stale bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: '“clip.mp4” was renamed or replaced. It was left unchanged.' }, { status: 409 })))
    await expect(readDesktopCardVideo('agent-1', 'shots/clip.mp4', '12:35')).rejects.toThrow(DesktopCardError)
    await expect(readDesktopCardVideo('agent-1', 'shots/clip.mp4', '12:35')).rejects.toThrow('renamed or replaced')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not a video', { headers: { 'content-type': 'text/plain' } })))
    await expect(readDesktopCardVideo('agent-1', 'shots/clip.mp4', '12:35')).rejects.toThrow('can’t be played')
    await expect(readDesktopCardVideo('agent-1', 'shots/clip.mp4', undefined)).rejects.toThrow('Send this video')
    await expect(readDesktopCardVideo('agent-1', 'shots/clip.mov', '12:35')).rejects.toThrow('not a supported video')
})
