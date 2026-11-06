import { expect, test } from 'vitest'
import type { DesktopRuntime } from '../runtime'
import { watchDesktopSecretAuthority, withDesktopSecretOwnerTransition, withDesktopSecretSessionTransition } from './lifecycle'

const runtime = (): DesktopRuntime => ({ protocolVersion: 1, launchNonce: crypto.randomUUID(), buildId: 'fixture', workspaceId: 1, dataRoot: '/secret-fixture', app: { origin: 'http://127.0.0.1:3100', sessionToken: 'x'.repeat(48) }, engine: { origin: 'http://127.0.0.1:3200', apiKey: 'fixture' } })
test('owner changes fence a prepared credential commit immediately, including after a rejected mutation', async () => {
    const run = runtime(), check = watchDesktopSecretAuthority(run, 'owner', 'chat')
    await expect(withDesktopSecretOwnerTransition(run, 'owner', async () => {
        expect(() => check()).toThrow('changed')
        expect(() => watchDesktopSecretAuthority(run, 'owner', 'chat')()).toThrow('changed')
        throw new Error('Grant write failed')
    })).rejects.toThrow('Grant write failed')
    expect(() => check()).toThrow('changed')
    expect(() => watchDesktopSecretAuthority(run, 'owner', 'chat')()).not.toThrow()
})
test('Stop fences only the exact chat while an owner change fences all its chats', async () => {
    const run = runtime(), first = watchDesktopSecretAuthority(run, 'owner', 'first'), sibling = watchDesktopSecretAuthority(run, 'owner', 'sibling')
    await withDesktopSecretSessionTransition(run, 'first', async () => {})
    expect(() => first()).toThrow('stopped')
    expect(() => sibling()).not.toThrow()
    await withDesktopSecretOwnerTransition(run, 'owner', async () => {})
    expect(() => sibling()).toThrow('changed')
    expect(() => watchDesktopSecretAuthority({ ...run, launchNonce: 'next-launch' }, 'owner', 'first')()).not.toThrow()
})
