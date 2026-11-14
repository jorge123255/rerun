import { expect, test, vi } from 'vitest'
import { findDesktopSubscriptionConnection, listDesktopSubscriptionConnections } from './connections.js'

const catalog = vi.hoisted(() => ({
    generation: '00000000-0000-4000-8000-000000000001',
    refreshedAt: '2026-11-11T00:00:00.000Z',
    models: [{ id: 'fixture-model', label: 'Fixture Model' }],
}))
vi.mock('./runtime.js', () => ({
    desktopSubscriptionChatAvailable: (provider: string) => provider === 'kimi-code',
    readDesktopSubscriptionCatalog: () => catalog,
}))

test('a catalog alone cannot expose a provider in the chat connection list', () => {
    const grok = `mac-grok-build-${catalog.generation}`
    const kimi = `mac-kimi-code-${catalog.generation}`
    expect(findDesktopSubscriptionConnection(grok)).toBeNull()
    expect(findDesktopSubscriptionConnection(kimi)).toMatchObject({ id: kimi, env: {} })
    expect(listDesktopSubscriptionConnections().map(connection => connection.id)).toEqual([kimi])
})
