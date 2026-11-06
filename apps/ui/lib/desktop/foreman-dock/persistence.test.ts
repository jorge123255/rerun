import { afterEach, expect, it, vi } from 'vitest'
import { createDockPersistence, bindForemanPlacement } from './persistence'
import { DEFAULT_DESKTOP_FOREMAN_PLACEMENT as placement } from '@/lib/desktop/foreman-client/persistence'
const chat = { workspaceId: 'workspace', chatId: 'fmc_abcdefgh' }
afterEach(() => vi.useRealTimers())
it('coalesces changes, admits the final immutable value and awaits the canonical ACK drain', async () => {
    vi.useFakeTimers()
    const commit = vi.fn(), flush = vi.fn(async () => true)
    const writer = createDockPersistence({ chat, current: () => chat, commit, flush })
    writer.change({ placement }); writer.change({ placement: { ...placement, dockWidth: 520 } })
    expect(commit).not.toHaveBeenCalled()
    expect(await writer.flush()).toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0][0].placement.dockWidth).toBe(520)
    expect(flush).toHaveBeenCalledOnce()
})
it('does not admit stale delayed writes after switching workspace or returning to an old scope', async () => {
    vi.useFakeTimers()
    let current = chat
    const commit = vi.fn()
    const writer = createDockPersistence({ chat, current: () => current, commit })
    writer.change({ placement }); current = { ...chat, workspaceId: 'other' }
    await vi.advanceTimersByTimeAsync(200)
    current = chat
    writer.dispose()
    expect(commit).not.toHaveBeenCalled()
})
it('propagates lost-ACK/conflict failure rather than claiming persistence or retrying over newer state', async () => {
    const commit = vi.fn(), flush = vi.fn(async () => false)
    const writer = createDockPersistence({ chat, current: () => chat, commit, flush })
    writer.change({ placement })
    expect(await writer.flush()).toBe(false)
    expect(commit).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
    writer.dispose()
})
it('binds only to the current existing UI setters, never replacing draft/chat state', () => {
    const setPlacement = vi.fn(), setDock = vi.fn()
    const binding = bindForemanPlacement({ chat, current: () => chat, setPlacement, setDock })
    binding.commit({ placement })
    expect(setPlacement).toHaveBeenCalledWith(placement)
    expect(setDock).not.toHaveBeenCalled()
})
it('survives React effect cleanup/re-activation and never replays an admitted patch', async () => {
    const commit = vi.fn(), flush = vi.fn(async () => true)
    const writer = createDockPersistence({ chat, current: () => chat, commit, flush })
    writer.dispose(); writer.activate()
    writer.change({ placement })
    expect(await writer.flush()).toBe(true)
    expect(await writer.flush()).toBe(true)
    expect(commit).toHaveBeenCalledOnce()
})
