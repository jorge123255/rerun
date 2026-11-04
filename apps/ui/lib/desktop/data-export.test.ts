// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { saveDesktopDataExport } from './data-export'

const url = '/api/desktop/agents/owner/data/export?table=notes&format=csv'
let clicks: { href: string; name: string }[]
beforeEach(() => {
    clicks = []
    vi.useFakeTimers()
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { clicks.push({ href: this.href, name: this.download }) })
})
afterEach(() => { vi.runAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

test('saves a bounded authenticated export through a download without opening a window', async () => {
    const popup = vi.spyOn(window, 'open')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('name\nExample', { headers: { 'content-type': 'text/csv; charset=utf-8' } })))
    const signal = new AbortController().signal
    await saveDesktopDataExport(url, '../notes', 'csv', signal)
    expect(fetch).toHaveBeenCalledWith(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal })
    expect(clicks).toEqual([{ href: 'blob:export', name: '.._notes.csv' }])
    expect(popup).not.toHaveBeenCalled()
    expect(document.querySelector('a[download]')).toBeNull()
    vi.runAllTimers()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:export')
})

test('refuses overflow from actual chunks, without trusting a small Content-Length', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5_000_001)) }, cancel }),
        { headers: { 'content-type': 'text/csv', 'content-length': '1' } })))
    await expect(saveDesktopDataExport(url, 'notes', 'csv', new AbortController().signal)).rejects.toThrow('5 MB')
    expect(cancel).toHaveBeenCalled()
    expect(clicks).toEqual([])
    expect(URL.createObjectURL).not.toHaveBeenCalled()
})

test('surfaces a refused export and never turns its error document into a file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Filter the table first.' }, { status: 413 })))
    await expect(saveDesktopDataExport(url, 'notes', 'csv', new AbortController().signal)).rejects.toThrow('Filter the table first.')
    expect(clicks).toEqual([])
})

test('closing while the body stalls cancels its reader and cannot download afterward', async () => {
    const controller = new AbortController(), cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/csv' } })))
    const work = saveDesktopDataExport(url, 'notes', 'csv', controller.signal)
    await Promise.resolve(); await Promise.resolve()
    controller.abort()
    await expect(work).rejects.toThrow()
    expect(cancel).toHaveBeenCalled()
    expect(clicks).toEqual([])
})

test('only the local fixed database export route can initiate a request', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(saveDesktopDataExport('https://example.org/', 'notes', 'csv', new AbortController().signal)).rejects.toThrow('Invalid')
    expect(fetch).not.toHaveBeenCalled()
})
