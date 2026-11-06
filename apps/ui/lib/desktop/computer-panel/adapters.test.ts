import { expect, test, vi } from 'vitest'
import { createHttpHumanLauncher, missingHumanLauncher, runtimeFromStatus } from './adapters'
import { MissingComputerPanelAuthority } from './contract'

const owner = { workspaceId: 'ws', agentId: 'a 1', sessionId: 's', runId: 'r', generation: 'a'.repeat(32) }
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

test('runtime status mapping does not guess running', () => {
    expect(runtimeFromStatus({ state: 'available', driving: false, running: false })).toEqual({ kind: 'container-stopped' })
    expect(runtimeFromStatus({ state: 'available', driving: false, running: true })).toEqual({ kind: 'running' })
    expect(runtimeFromStatus({ state: 'unavailable', driving: false, reason: 'Docker is not running' })).toEqual({ kind: 'docker-absent' })
    expect(runtimeFromStatus({ state: 'disconnected', driving: false })).toEqual({ kind: 'disconnected' })
})

test('missing launcher authority is explicit', async () => {
    await expect(missingHumanLauncher(owner, 'files', 'id', new AbortController().signal)).rejects.toBeInstanceOf(MissingComputerPanelAuthority)
})

test('HTTP launcher sends exact identity and requires acknowledged success', async () => {
    const fetcher = vi.fn(async () => res(200, { status: 'opened', acknowledged: true }))
    await expect(createHttpHumanLauncher(fetcher as unknown as typeof fetch)(owner, 'terminal', 'req', new AbortController().signal)).resolves.toEqual({ status: 'opened' })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/desktop/agents/a%201/sessions/s/computer-launcher')
    expect(JSON.parse(init.body as string)).toEqual({ requestId: 'req', runId: 'r', generation: 'a'.repeat(32), app: 'terminal' })
    const unacked = vi.fn(async () => res(200, { status: 'opened', acknowledged: false }))
    await expect(createHttpHumanLauncher(unacked as unknown as typeof fetch)(owner, 'files', 'req', new AbortController().signal)).resolves.toMatchObject({ status: 'interrupted' })
    const absent = vi.fn(async () => res(404, {}))
    await expect(createHttpHumanLauncher(absent as unknown as typeof fetch)(owner, 'files', 'req', new AbortController().signal)).rejects.toBeInstanceOf(MissingComputerPanelAuthority)
})
