import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopBrainPagesActions } from './brain-pages'

const actions = createDesktopBrainPagesActions(async () => 0)
afterEach(() => vi.restoreAllMocks())
it('returns null only for confirmed missing reads and keeps unavailable storage as an error', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }))
    expect(await actions.readPage('company')).toBeNull()
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    await expect(actions.readRevision('company', 'revision')).rejects.toMatchObject({ status: 503 })
})
it('does not invent a successful overview when proposal storage is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"pages":[]}'))
    const unavailable = createDesktopBrainPagesActions(async () => { throw new Error('proposal storage unavailable') })
    await expect(unavailable.load()).rejects.toThrow('proposal storage unavailable')
})
it('requires restore guards and sends the supplied stable receipt identity', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 409 }))
    const invalid = await actions.revertPage('company', 'revision', undefined as unknown as string, 'receipt-one')
    expect(invalid.ok).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
    const conflict = await actions.revertPage('company', 'revision', 'a'.repeat(32), 'receipt-one')
    expect(conflict).toMatchObject({ ok: false, conflict: true, uncertain: false })
    const [, options] = fetcher.mock.calls[0]!
    expect(JSON.parse(options!.body as string)).toEqual({ expectedHash: 'a'.repeat(32), requestId: 'receipt-one' })
})
it('marks an unknown transport result as uncertain and preserves the caller request ID on retry', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('lost after commit'))
    const input = { title: 'Company', type: 'company' as const, content: 'Facts', sources: [], baseHash: null }
    expect(await actions.savePage('company', input, 'receipt-unknown')).toMatchObject({ ok: false, uncertain: true })
    expect(await actions.savePage('company', input, 'receipt-unknown')).toMatchObject({ ok: false, uncertain: true })
    expect(fetcher.mock.calls.map(([, options]) => JSON.parse(options!.body as string))).toEqual([{ ...input, requestId: 'receipt-unknown' }, { ...input, requestId: 'receipt-unknown' }])
})
it('binds delete and confirmation to the displayed page version', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 409 }))
    await actions.deletePage('company', 'a'.repeat(32), 'receipt-delete')
    await actions.confirmSections('company', ['Facts'], 'b'.repeat(32), 'receipt-confirm')
    expect(fetcher.mock.calls.map(([, options]) => JSON.parse(options!.body as string))).toEqual([
        { expectedHash: 'a'.repeat(32), requestId: 'receipt-delete' },
        { headings: ['Facts'], expectedHash: 'b'.repeat(32), requestId: 'receipt-confirm' },
    ])
})
