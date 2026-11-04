import { CARD_MAX_FILES, CARD_MAX_IMAGE_BYTES, CARD_MAX_IMAGE_TOTAL_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES } from '@rerun/contracts'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopCardError, desktopFileCardOf, readDesktopCardFile, readDesktopCardImage } from './file-card'

afterEach(() => vi.unstubAllGlobals())

const file = (over: Record<string, unknown> = {}) => ({ path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent', ...over })
const image = (over: Record<string, unknown> = {}) => ({ path: 'shots/photo.png', name: 'photo.png', size: 1024, scope: 'agent', identity: '12:34', ...over })
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

test('keeps the endpoint identity for an image and preserves a text card without one', () => {
    expect(desktopFileCardOf(card([image()]))).toEqual({
        kind: 'file', files: [{ path: 'shots/photo.png', name: 'photo.png', size: 1024, scope: 'agent', identity: '12:34' }],
    })
    expect(desktopFileCardOf(card([file(), image()]))).toEqual({
        kind: 'file', files: [
            { path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' },
            { path: 'shots/photo.png', name: 'photo.png', size: 1024, scope: 'agent', identity: '12:34' },
        ],
    })
})

test.each([
    ['a shared file', card([file({ scope: 'shared' })])],
    ['a shared image', card([image({ scope: 'shared' })])],
    ['an absolute path', card([file({ path: '/tmp/summary.md' })])],
    ['an absolute image path', card([image({ path: '/tmp/photo.png', name: 'photo.png' })])],
    ['traversal', card([file({ path: '../summary.md' })])],
    ['a hidden segment', card([file({ path: '.secret/summary.md' })])],
    ['a hidden image segment', card([image({ path: '.secret/photo.png', name: 'photo.png' })])],
    ['a backslash', card([file({ path: 'reports\\summary.md' })])],
    ['an unsupported document', card([file({ path: 'reports/image.svg', name: 'image.svg' })])],
    ['an unsupported image', card([image({ path: 'shots/photo.avif', name: 'photo.avif' })])],
    ['a video', card([image({ path: 'shots/clip.mp4', name: 'clip.mp4' })])],
    ['a pdf', card([image({ path: 'shots/deck.pdf', name: 'deck.pdf' })])],
    ['a mismatched name', card([file({ name: 'other.md' })])],
    ['a mismatched image name', card([image({ name: 'other.png' })])],
    ['a negative size', card([file({ size: -1 })])],
    ['a NaN size', card([file({ size: Number.NaN })])],
    ['an infinite size', card([file({ size: Number.POSITIVE_INFINITY })])],
    ['an oversized text file', card([file({ size: DESKTOP_ATTACHMENT_MAX_BYTES + 1 })])],
    ['an oversized image', card([image({ size: CARD_MAX_IMAGE_BYTES + 1 })])],
    ['an empty image', card([image({ size: 0 })])],
    ['an image without identity', card([image({ identity: undefined })])],
    ['an image with malformed identity', card([image({ identity: 'not-an-inode' })])],
    ['an empty card', { kind: 'file', files: [] }],
    ['too many files', card(Array.from({ length: CARD_MAX_FILES + 1 }, (_, index) => file({ path: `reports/${index}.md`, name: `${index}.md` })))],
    ['prose', 'Could not show that file, nothing was shown.'],
    ['malformed JSON', '{"kind":"file"'],
    ['an error wrapper', { type: 'text', value: 'Could not show that file, nothing was shown.' }],
])('rejects %s rather than drawing a partial or invented card', (_name, value) => {
    expect(desktopFileCardOf(value)).toBeUndefined()
})

test('bounds the text edge, image edge and aggregate image preview budget', () => {
    const files = Array.from({ length: CARD_MAX_FILES }, (_, index) => file({ path: `reports/${index}.md`, name: `${index}.md` }))
    expect(desktopFileCardOf(card(files))?.files).toHaveLength(CARD_MAX_FILES)
    expect(desktopFileCardOf(card([file({ size: DESKTOP_ATTACHMENT_MAX_BYTES })]))?.files[0].size).toBe(DESKTOP_ATTACHMENT_MAX_BYTES)
    expect(desktopFileCardOf(card([image({ size: CARD_MAX_IMAGE_BYTES })]))?.files[0].size).toBe(CARD_MAX_IMAGE_BYTES)
    const withinBudget = Array.from({ length: 3 }, (_, index) => image({ path: `shots/${index}.webp`, name: `${index}.webp`, size: CARD_MAX_IMAGE_BYTES }))
    expect(desktopFileCardOf(card(withinBudget))?.files).toHaveLength(3)
    const overBudget = [...withinBudget, image({ path: 'shots/extra.gif', name: 'extra.gif', size: 1 })]
    expect(desktopFileCardOf(card(overBudget))).toBeUndefined()
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
