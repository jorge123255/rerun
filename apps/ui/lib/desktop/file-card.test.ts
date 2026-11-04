import { CARD_MAX_FILES, DESKTOP_ATTACHMENT_MAX_BYTES } from '@rerun/contracts'
import { afterEach, expect, test, vi } from 'vitest'
import { desktopFileCardOf, readDesktopCardFile } from './file-card'

afterEach(() => vi.unstubAllGlobals())

const file = (over: Record<string, unknown> = {}) => ({ path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent', ...over })
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
    expect(desktopFileCardOf({ ...card([file({ token: 'private' })]), extra: 'private' })).toEqual({
        kind: 'file', files: [{ path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' }],
    })
})

test.each([
    ['a shared file', card([file({ scope: 'shared' })])],
    ['an absolute path', card([file({ path: '/tmp/summary.md' })])],
    ['traversal', card([file({ path: '../summary.md' })])],
    ['a hidden segment', card([file({ path: '.secret/summary.md' })])],
    ['a backslash', card([file({ path: 'reports\\summary.md' })])],
    ['an unsupported format', card([file({ path: 'reports/image.png', name: 'image.png' })])],
    ['a mismatched name', card([file({ name: 'other.md' })])],
    ['a negative size', card([file({ size: -1 })])],
    ['a NaN size', card([file({ size: Number.NaN })])],
    ['an infinite size', card([file({ size: Number.POSITIVE_INFINITY })])],
    ['an oversized file', card([file({ size: DESKTOP_ATTACHMENT_MAX_BYTES + 1 })])],
    ['an empty card', { kind: 'file', files: [] }],
    ['too many files', card(Array.from({ length: CARD_MAX_FILES + 1 }, (_, index) => file({ path: `reports/${index}.md`, name: `${index}.md` })))],
    ['prose', 'Could not show that file, nothing was shown.'],
    ['malformed JSON', '{"kind":"file"'],
    ['an error wrapper', { type: 'text', value: 'Could not show that file, nothing was shown.' }],
])('rejects %s rather than drawing a partial or invented card', (_name, value) => {
    expect(desktopFileCardOf(value)).toBeUndefined()
})

test('accepts the bounded edge and every file in a full card', () => {
    const files = Array.from({ length: CARD_MAX_FILES }, (_, index) => file({ path: `reports/${index}.md`, name: `${index}.md` }))
    expect(desktopFileCardOf(card(files))?.files).toHaveLength(CARD_MAX_FILES)
    expect(desktopFileCardOf(card([file({ size: DESKTOP_ATTACHMENT_MAX_BYTES })]))?.files[0].size).toBe(DESKTOP_ATTACHMENT_MAX_BYTES)
})

test('reads a card file through the authenticated desktop files route', async () => {
    const fetch = vi.fn(async () => Response.json({ content: '# Current', truncated: false }))
    vi.stubGlobal('fetch', fetch)
    await expect(readDesktopCardFile('agent 1', 'reports/summary.md')).resolves.toEqual({ content: '# Current', truncated: false })
    expect(fetch).toHaveBeenCalledWith('/api/desktop/agents/agent%201/files/read?path=reports%2Fsummary.md', { cache: 'no-store' })
})

test('reports a deleted or unreadable card file instead of returning stale bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'File not found' }, { status: 404 })))
    await expect(readDesktopCardFile('agent-1', 'reports/summary.md')).rejects.toThrow('File not found')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ content: { hidden: 'not text' } })))
    await expect(readDesktopCardFile('agent-1', 'reports/summary.md')).rejects.toThrow('no longer available')
})
