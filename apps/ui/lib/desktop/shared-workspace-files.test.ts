import { afterEach, expect, test, vi } from 'vitest'
import { importDesktopSharedFile, listDesktopSharedFolder, readDesktopSharedPreview } from './shared-workspace-files'

afterEach(() => { vi.unstubAllGlobals() })

test('shared file requests carry only the relative path', async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({ path: 'notes', entries: [], truncated: false, content: 'ok' }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await listDesktopSharedFolder('notes')
    await readDesktopSharedPreview('notes/a.txt')
    await importDesktopSharedFile('notes', new File(['ok'], 'a.txt'))
    const urls = fetch.mock.calls.map(call => String(call[0]))
    expect(urls).toEqual([
        '/api/desktop/shared-files?path=notes',
        '/api/desktop/shared-files/read?path=notes%2Fa.txt',
        '/api/desktop/shared-files',
    ])
    expect(urls.join(' ')).not.toMatch(/root|engineId|scope|agentId/)
    const init = fetch.mock.calls[2]?.[1] as RequestInit
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeInstanceOf(FormData)
    expect((init?.body as FormData).get('path')).toBe('notes')
    expect((init?.body as FormData).has('root')).toBe(false)
})

test('rejects oversized or non-text picks before uploading and passes caller cancellation to all requests', async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => Response.json({ path: '', entries: [], content: 'ok', truncated: false }))
    vi.stubGlobal('fetch', fetch)
    await expect(importDesktopSharedFile('', new File([new Uint8Array(1024 * 1024 + 1)], 'large.txt'))).rejects.toThrow('up to 1 MB')
    await expect(importDesktopSharedFile('', new File(['x'], 'image.png'))).rejects.toThrow('Only .txt and .md')
    expect(fetch).not.toHaveBeenCalled()
    const controller = new AbortController()
    await listDesktopSharedFolder('', controller.signal)
    await readDesktopSharedPreview('a.txt', controller.signal)
    await importDesktopSharedFile('', new File(['x'], 'a.txt'), controller.signal)
    controller.abort()
    expect(fetch.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true)
})
