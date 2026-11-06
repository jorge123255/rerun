import { expect, test, vi } from 'vitest'
import { remoteMachineHandlers } from './handlers'
const actor = { installId: '00000000-0000-4000-8000-000000000001', workspaceId: 1, launchNonce: '00000000-0000-4000-8000-000000000002', rendererEpoch: '00000000-0000-4000-8000-000000000003' }
const requestId = '00000000-0000-4000-8000-000000000004'
const read = () => new Request('http://127.0.0.1/api/desktop/remote-machines', { method: 'POST', body: JSON.stringify({ action: 'read', actor, requestId }) })
test('an old renderer/IPC lease is refused again after native await, without stale publication', async () => {
    let current = actor
    const bridge = { execute: vi.fn(async () => {
        current = { ...actor, rendererEpoch: requestId }
        return { ok: true as const, snapshot: { version: 1 as const, actor, revision: 'unconfigured' as const, connection: null, selected: false, runtimeState: 'unknown' as const, activeReceipt: null, openReceipt: null }, receipt: null }
    }) }
    const response = await remoteMachineHandlers(bridge, async () => current).post(read())
    expect(response.status).toBe(409); expect(bridge.execute).toHaveBeenCalledOnce()
})
test('malformed input, unavailable native bridge and oversized bodies remain errors', async () => {
    const bridge = { execute: vi.fn(async () => { throw Error('Native bridge unavailable') }) }
    const handler = remoteMachineHandlers(bridge, async () => actor)
    expect((await handler.post(read())).status).toBe(503)
    expect((await handler.post(new Request('http://127.0.0.1', { method: 'POST', body: '{}' }))).status).toBe(400)
    expect((await handler.post(new Request('http://127.0.0.1', { method: 'POST', body: 'x'.repeat(16385) }))).status).toBe(413)
})
