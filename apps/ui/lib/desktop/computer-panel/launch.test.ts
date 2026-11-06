import { expect, test, vi } from 'vitest'
import { MissingComputerPanelAuthority, type ComputerPanelOwner } from './contract'
import { createComputerLauncher, type LaunchAttempt } from './launch'

const owner: ComputerPanelOwner = { workspaceId: 'ws', agentId: 'a', sessionId: 's', runId: 'r', generation: 'a'.repeat(32) }
const deferred = <T,>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

test('duplicate clicks while pending send one request', async () => {
    const d = deferred<{ status: 'opened' }>()
    const launchApp = vi.fn(() => d.promise)
    const l = createComputerLauncher(owner, { launchApp, revalidateOwner: async () => true }, () => {}, () => 'id1')
    const first = l.launch('terminal'); void l.launch('terminal'); void l.launch('files')
    await Promise.resolve(); await Promise.resolve()
    d.resolve({ status: 'opened' }); await first
    expect(launchApp).toHaveBeenCalledTimes(1)
    expect(l.attempt).toMatchObject({ phase: 'acknowledged', requestId: 'id1' })
})

test('lost ACK becomes uncertain, blocks other apps and retries with the same requestId', async () => {
    let n = 0
    const launchApp = vi.fn(async (_o: ComputerPanelOwner, _a: 'terminal' | 'files', id: string) => { if (n++ === 0) throw new TypeError('network'); return { status: 'focused' as const, id } })
    const ids = ['first', 'second']
    const l = createComputerLauncher(owner, { launchApp, revalidateOwner: async () => true }, () => {}, () => ids.shift()!)
    await l.launch('files')
    expect(l.attempt).toMatchObject({ phase: 'uncertain', requestId: 'first' })
    await l.launch('terminal')
    expect(launchApp).toHaveBeenCalledTimes(1)
    await l.launch('files')
    expect(launchApp.mock.calls[1][2]).toBe('first')
    expect(l.attempt).toMatchObject({ phase: 'acknowledged' })
})

test('owner revalidation failure never launches', async () => {
    const launchApp = vi.fn()
    const l = createComputerLauncher(owner, { launchApp, revalidateOwner: async () => false }, () => {})
    await l.launch('terminal')
    expect(launchApp).not.toHaveBeenCalled()
    expect(l.attempt).toMatchObject({ phase: 'failed' })
})

test('missing authority reports a truthful refusal, not success', async () => {
    const l = createComputerLauncher(owner, { launchApp: async () => { throw new MissingComputerPanelAuthority('H-A1 human launcher route') }, revalidateOwner: async () => true }, () => {})
    await l.launch('files')
    expect(l.attempt).toMatchObject({ phase: 'failed', reason: expect.stringContaining('not available') })
})

test('late reply after dispose (owner change) is ignored', async () => {
    const d = deferred<{ status: 'opened' }>()
    const seen: (LaunchAttempt | null)[] = []
    const l = createComputerLauncher(owner, { launchApp: () => d.promise, revalidateOwner: async () => true }, a => seen.push(a))
    const p = l.launch('terminal'); await Promise.resolve(); await Promise.resolve()
    l.dispose(); d.resolve({ status: 'opened' }); await p
    expect(seen.map(a => a?.phase)).toEqual(['pending'])
})
