import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopBrainPagesActions, desktopBrainPagesActions } from './brain-pages'

afterEach(() => vi.restoreAllMocks())
it('keeps missing/unavailable reads and revision failures as errors', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }))
    await expect(desktopBrainPagesActions.readBrainPageAction('company')).rejects.toMatchObject({ status: 404 })
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    await expect(desktopBrainPagesActions.readBrainRevisionAction('company', 'revision')).rejects.toMatchObject({ status: 503 })
})
it('does not invent a successful overview when proposal storage is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"pages":[]}'))
    const actions = createDesktopBrainPagesActions(async () => { throw new Error('proposal storage unavailable') })
    await expect(actions.loadBrainAction()).rejects.toThrow('proposal storage unavailable')
})
it('requires restore guards and returns structured conflict failures', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 409 }))
    const invalid = await desktopBrainPagesActions.revertBrainPageAction('company', 'revision', undefined as unknown as string)
    expect(invalid.ok).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
    const conflict = await desktopBrainPagesActions.revertBrainPageAction('company', 'revision', 'a'.repeat(32))
    expect(conflict).toMatchObject({ ok: false, conflict: true })
    const [, options] = fetcher.mock.calls[0]!
    expect(JSON.parse(options!.body as string)).toEqual({ expectedHash: 'a'.repeat(32) })
})
