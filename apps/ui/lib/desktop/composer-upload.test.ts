import { afterEach, expect, test, vi } from 'vitest'
import { DESKTOP_ATTACHMENT_MAX_BYTES, DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES } from '@rerun/contracts'
import { desktopAttachmentSizes, importDesktopUpload, preflightDesktopUploads, type DesktopUploadStatus } from './composer-upload'

const file = (name: string, content: string | Uint8Array = 'hello', type = 'text/plain') => new File([content], name, { type })
const sized = (bytes: number, name = 'big.txt') => new File([new Uint8Array(bytes)], name)
const pending = (size: number, status: DesktopUploadStatus = 'queued') => ({ size, status })

afterEach(() => vi.unstubAllGlobals())

test('preflight accepts valid text files in order and refuses unsupported, oversized, and non-text picks', async () => {
    const good = file('notes.md', '# hi')
    const also = file('plain.txt')
    const image = file('photo.png', 'x', 'image/png')
    const huge = sized(DESKTOP_ATTACHMENT_MAX_BYTES + 1)
    const binary = file('blob.txt', new Uint8Array([0x41, 0x00, 0x42]))
    const control = file('ctrl.txt', 'a\x07b')
    const result = await preflightDesktopUploads({
        files: [good, image, also, huge, binary, control],
        attachedPaths: [], attachedSizes: new Map(), pending: [],
    })
    expect(result.blockers).toEqual([])
    expect(result.accepted).toEqual([good, also])
    expect(result.rejected.map(item => item.file.name)).toEqual(['photo.png', 'big.txt', 'blob.txt', 'ctrl.txt'])
    expect(result.rejected[0]!.reason).toContain('.txt')
    expect(result.rejected[1]!.reason).toContain('KiB')
})

test('preflight counts existing attachments, in-flight uploads, per-file size, and the shared total', async () => {
    const existing = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md', 'h.md']
    const sizes = new Map(existing.map(path => [path, 100]))
    const batch = [file('1.txt'), file('2.txt'), file('3.txt')]
    const result = await preflightDesktopUploads({
        files: batch,
        attachedPaths: existing,
        attachedSizes: sizes,
        pending: [pending(10)],
    })
    expect(result.accepted).toEqual([batch[0]!])
    expect(result.rejected.map(item => item.file.name)).toEqual(['2.txt', '3.txt'])
    expect(result.rejected[0]!.reason).toContain('10 files')

    const tight = await preflightDesktopUploads({
        files: [sized(30000, 'x.txt'), sized(30000, 'y.txt'), sized(30000, 'z.txt')],
        attachedPaths: ['a.md'],
        attachedSizes: new Map([['a.md', DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES - 60000]]),
        pending: [],
    })
    expect(tight.accepted.map(item => item.name)).toEqual(['x.txt', 'y.txt'])
    expect(tight.rejected[0]!.reason).toContain('total')
})

test('preflight refuses the batch when an existing attachment is missing or its size is unknown', async () => {
    const missing = await preflightDesktopUploads({
        files: [file('a.txt')], attachedPaths: ['gone.md'],
        attachedSizes: new Map([['gone.md', 'missing']]), pending: [],
    })
    expect(missing.accepted).toEqual([])
    expect(missing.blockers[0]).toContain('no longer available')

    const unknown = await preflightDesktopUploads({
        files: [file('a.txt')], attachedPaths: ['a.md'],
        attachedSizes: new Map(), pending: [],
    })
    expect(unknown.accepted).toEqual([])
    expect(unknown.blockers[0]).toContain('Could not check')
})

test('importDesktopUpload returns the confirmed path, treats 4xx as definitive, and everything else as ambiguous', async () => {
    const post = vi.fn()
    vi.stubGlobal('fetch', post)
    const good = file('a.txt')

    post.mockResolvedValueOnce(Response.json({ path: 'a.txt', name: 'a.txt' }, { status: 201 }))
    expect(await importDesktopUpload('alice', good)).toEqual({ ok: true, path: 'a.txt', name: 'a.txt' })
    expect(post.mock.calls[0]![1]?.method).toBe('POST')

    post.mockResolvedValueOnce(Response.json({ error: 'This folder already has a file named “a.txt”.' }, { status: 409 }))
    const conflict = await importDesktopUpload('alice', good)
    expect(conflict).toMatchObject({ ok: false, kind: 'rejected' })
    if (!conflict.ok) expect(conflict.message).toContain('already has a file')

    post.mockResolvedValueOnce(Response.json({ error: 'nope' }, { status: 500 }))
    expect(await importDesktopUpload('alice', good)).toMatchObject({ ok: false, kind: 'ambiguous' })

    post.mockResolvedValueOnce(new Response('not json', { status: 201 }))
    expect(await importDesktopUpload('alice', good)).toMatchObject({ ok: false, kind: 'ambiguous' })

    post.mockRejectedValueOnce(new TypeError('network down'))
    await expect(importDesktopUpload('alice', good)).rejects.toThrow('network down')
})

test('desktopAttachmentSizes maps folder entries to sizes and marks absent files missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://local')
        if (url.searchParams.get('path') === 'docs') return Response.json({ entries: [{ name: 'a.md', type: 'file', size: 12 }, { name: 'dir', type: 'dir', size: 0 }] })
        if (url.searchParams.get('path') === '') return Response.json({ entries: [{ name: 'root.txt', type: 'file', size: 8 }] })
        return Response.json({ error: 'Folder not found' }, { status: 404 })
    }))
    const sizes = await desktopAttachmentSizes('alice', ['docs/a.md', 'docs/gone.md', 'root.txt', 'empty/x.txt'])
    expect(sizes.get('docs/a.md')).toBe(12)
    expect(sizes.get('docs/gone.md')).toBe('missing')
    expect(sizes.get('root.txt')).toBe(8)
    expect(sizes.get('empty/x.txt')).toBe('missing')
})
