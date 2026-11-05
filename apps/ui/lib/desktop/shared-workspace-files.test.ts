import { afterEach, expect, test, vi } from 'vitest'
import { importDesktopSharedFile, listDesktopSharedFolder, readDesktopSharedPreview } from './shared-workspace-files'

afterEach(() => { vi.unstubAllGlobals() })

test('shared file requests carry only the relative path', async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify({ path: 'notes', entries: [], truncated: false, content: 'ok' }), { status: 200 }))
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
