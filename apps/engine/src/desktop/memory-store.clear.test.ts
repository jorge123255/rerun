import { beforeEach, expect, it, vi } from 'vitest'

/**
 * Unrun source regressions for clear → semantic wipe binding.
 * No real filesystem / libSQL / provider. Exercises lock-ordering port contract only.
 */

const state = vi.hoisted(() => ({
    desktop: true,
    cleared: [] as string[],
    accept: true as boolean,
    reason: 'cleared' as string,
    insideLockReads: 0,
    lockDepth: 0,
}))

vi.mock('./policy.js', () => ({ desktopApp: () => state.desktop }))
vi.mock('./semantic-memory/events.js', () => ({
    desktopMemoryChanged: vi.fn(),
}))
vi.mock('./memory-paths.js', () => ({
    desktopMemoryPaths: async () => ({ memory: '/tmp/unused/memory', hasMemory: false, hasIndex: false, data: undefined }),
}))
vi.mock('../lib/lock.js', () => ({
    withKeyedLock: async (_key: string, action: () => Promise<unknown>) => {
        state.lockDepth += 1
        try { return await action() }
        finally { state.lockDepth -= 1 }
    },
}))

beforeEach(() => {
    state.desktop = true
    state.cleared = []
    state.accept = true
    state.reason = 'cleared'
    state.insideLockReads = 0
    state.lockDepth = 0
    vi.resetModules()
})

it('awaits bound notesCleared only after the memory lock releases', async () => {
    const { bindDesktopMemorySemanticClear, clearDesktopMemories } = await import('./memory-store.js')
    bindDesktopMemorySemanticClear({
        async notesCleared(agentId) {
            if (state.lockDepth !== 0) state.insideLockReads += 1
            state.cleared.push(agentId)
            return { accepted: state.accept, reason: state.reason as 'cleared' }
        },
    })
    await clearDesktopMemories('owner-a')
    expect(state.cleared).toEqual(['owner-a'])
    expect(state.insideLockReads).toBe(0)
})

it('does not wipe a sibling coworker when clearing one owner', async () => {
    const { bindDesktopMemorySemanticClear, clearDesktopMemories } = await import('./memory-store.js')
    bindDesktopMemorySemanticClear({
        async notesCleared(agentId) {
            state.cleared.push(agentId)
            return { accepted: true, reason: 'cleared' }
        },
    })
    await clearDesktopMemories('alpha')
    expect(state.cleared).toEqual(['alpha'])
})

it('surfaces a rejected or unbound wipe instead of claiming clear success', async () => {
    const { bindDesktopMemorySemanticClear, clearDesktopMemories } = await import('./memory-store.js')
    bindDesktopMemorySemanticClear(null)
    await expect(clearDesktopMemories('owner-a')).rejects.toThrow(/index wipe is unavailable/)

    bindDesktopMemorySemanticClear({
        async notesCleared() {
            return { accepted: false, reason: 'bounds' }
        },
    })
    await expect(clearDesktopMemories('owner-a')).rejects.toThrow(/could not be cleared \(bounds\)/)
})

it('skips wipe when not running as the desktop app (non-desktop hosts keep prior clear semantics)', async () => {
    state.desktop = false
    const { bindDesktopMemorySemanticClear, clearDesktopMemories } = await import('./memory-store.js')
    bindDesktopMemorySemanticClear({
        async notesCleared(agentId) {
            state.cleared.push(agentId)
            return { accepted: true, reason: 'cleared' }
        },
    })
    await clearDesktopMemories('owner-a')
    expect(state.cleared).toEqual([])
})
