import { expect, test, vi } from 'vitest'
import { createDesktopScreenSession } from './screen-session'
function setup() {
    const api = {
        fetchDesktopScreenStatus: vi.fn(async () => ({ state: 'disconnected' as const, driving: false })),
        startDesktopScreenTakeover: vi.fn(async () => ({ lease: 'first' })),
        requestDesktopScreenTicket: vi.fn(async () => ({ socketUrl: 'ws://127.0.0.1/socket', expiresAt: '', width: 100, height: 100 })),
        finishDesktopScreenTakeover: vi.fn(async () => ({ url: 'https://example.com' })),
    }
    return { api, session: createDesktopScreenSession('owner', api) }
}
test('a stopped screen can request a fresh view without acquiring human control', async () => {
    const { api, session } = setup()
    expect(await session.connect('watch')).toHaveProperty('socketUrl')
    expect(api.startDesktopScreenTakeover).not.toHaveBeenCalled()
    expect(api.requestDesktopScreenTicket).toHaveBeenCalledWith('owner', 'watch', expect.any(AbortSignal), undefined)
    await session.close()
})
test('closing during takeover cancels requests and compensates a late lease', async () => {
    const { api, session } = setup()
    let resolve!: (value: { lease: string }) => void
    api.startDesktopScreenTakeover.mockImplementation(() => new Promise(r => { resolve = r }))
    const connecting = session.connect('drive'); const refusal = expect(connecting).rejects.toThrow()
    await vi.waitFor(() => expect(resolve).toBeDefined())
    const signal = (api.startDesktopScreenTakeover.mock.calls[0] as unknown as [string, undefined, AbortSignal])[2]
    await session.close(); expect(signal.aborted).toBe(true)
    resolve({ lease: 'late' }); await refusal
    expect(api.finishDesktopScreenTakeover).toHaveBeenCalledWith('owner', 'late', expect.any(AbortSignal))
    expect(api.requestDesktopScreenTicket).not.toHaveBeenCalled()
})
test('reconnect releases stale control and binds the new drive ticket to a fresh lease', async () => {
    const { api, session } = setup()
    await session.connect('drive')
    api.startDesktopScreenTakeover.mockResolvedValue({ lease: 'second' })
    await session.connect('drive')
    expect(api.finishDesktopScreenTakeover).toHaveBeenCalledWith('owner', 'first', expect.any(AbortSignal))
    expect(api.requestDesktopScreenTicket).toHaveBeenLastCalledWith('owner', 'drive', expect.any(AbortSignal), 'second')
    await session.close()
})
test('a failed release retains its lease for an exact retry rather than acquiring more control', async () => {
    const { api, session } = setup(); await session.connect('drive')
    api.finishDesktopScreenTakeover.mockRejectedValueOnce(new Error('offline'))
    await expect(session.finish()).rejects.toThrow('offline')
    await session.finish()
    expect(api.finishDesktopScreenTakeover).toHaveBeenNthCalledWith(2, 'owner', 'first', expect.any(AbortSignal))
    await session.close()
})
test('failed drive ticket admission releases the just-acquired lease', async () => {
    const { api, session } = setup()
    api.requestDesktopScreenTicket.mockRejectedValue(new Error('revoked'))
    await expect(session.connect('drive')).rejects.toThrow('revoked')
    expect(api.finishDesktopScreenTakeover).toHaveBeenCalledTimes(1)
    await session.close()
})


test('an explicit expired cleanup receipt clears the old lease and permits reconnect', async () => {
    const { api, session } = setup(); await session.connect('drive')
    api.finishDesktopScreenTakeover.mockResolvedValueOnce({ url: null, expired: true } as unknown as { url: string })
    api.startDesktopScreenTakeover.mockResolvedValue({ lease: 'new-generation' })
    await session.connect('drive')
    expect(api.requestDesktopScreenTicket).toHaveBeenLastCalledWith('owner', 'drive', expect.any(AbortSignal), 'new-generation')
    await session.close()
})
