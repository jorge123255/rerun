import { afterEach, expect, it, vi } from 'vitest'
const lifecycle = vi.hoisted(() => ({ quitting: false, held: 0 }))
vi.mock('./draft-writes', () => ({ isDesktopQuitting: () => lifecycle.quitting, holdDraftAdmission: () => { lifecycle.held++; return () => { lifecycle.held-- } } }))
import { desktopPreferredView } from './data-preferences'
afterEach(() => { vi.unstubAllGlobals(); lifecycle.quitting = false })

it('serializes selections across source instances, waits before reads, and holds Quit until receipts arrive', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const seen: (string | null)[] = []
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body))
            seen.push(body.viewId)
            if (seen.length === 1) await gate
            return Response.json({ saved: true })
        }
        return Response.json({ viewId: seen.at(-1) ?? null })
    })
    vi.stubGlobal('fetch', fetch)
    const one = desktopPreferredView({ kind: 'shared' }), two = desktopPreferredView({ kind: 'shared' })
    const first = one.write('notes', 'list'), second = two.write('notes', 'gallery'), read = one.read('notes')
    await Promise.resolve(); await Promise.resolve()
    expect(seen).toEqual(['list'])
    expect(lifecycle.held).toBe(2)
    release()
    await Promise.all([first, second])
    expect(await read).toBe('gallery')
    expect(seen).toEqual(['list', 'gallery'])
    expect(lifecycle.held).toBe(0)
})

it('does not acknowledge a failed or malformed receipt and allows an explicit retry', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Disk unavailable' }, { status: 503 }))
        .mockResolvedValueOnce(Response.json({ saved: false })).mockResolvedValueOnce(Response.json({ saved: true }))
    vi.stubGlobal('fetch', fetch)
    const preference = desktopPreferredView({ kind: 'agent', agentId: 'one' })
    await expect(preference.write('notes', 'gallery')).rejects.toThrow('Disk unavailable')
    await expect(preference.write('notes', 'gallery')).rejects.toThrow('not confirmed')
    await expect(preference.write('notes', 'gallery')).resolves.toBeUndefined()
    lifecycle.quitting = true
    await expect(preference.write('notes', null)).rejects.toThrow('closing')
    expect(fetch).toHaveBeenCalledTimes(3)
})
