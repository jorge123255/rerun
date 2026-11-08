import { describe, expect, it, vi } from 'vitest'
import { createDesktopMcpLoginBackend, type ApprovedDeviceFallback, type RemoteLoginService } from './backend.js'

const identity = { engineAgentId: 'engine-a', sessionId: 'chat-a', runId: 'run-a' }
const request = { action: 'status', identity, toolCallId: 'call-a' }
function setup() {
    let owner = 'local-a', live = true, epoch = 0
    let rows = [{ name: 'linear', revision: 'r1', url: 'https://linear.example/mcp', hasBearer: false, transport: 'http' as const }]
    const service: RemoteLoginService = {
        shutdownSignal: new AbortController().signal,
        authorizeRun: vi.fn(async (input) => { if (!live || JSON.stringify(input) !== JSON.stringify(identity)) throw new Error('inactive'); return owner }),
        store: { list: vi.fn(async () => rows.map(row => ({ ...row }))), lifecycle: { watch: () => { const saved = epoch; return () => { if (saved !== epoch) throw new Error('changed') } } } },
        runtime: { probe: vi.fn(async () => ({ tools: [{ name: 'search' }] })) },
    }
    const watch = () => { const saved = epoch; return () => { if (saved !== epoch) throw new Error('changed') } }
    return { service, watch, dispatch: createDesktopMcpLoginBackend(service, watch),
        stop: () => { live = false }, switchOwner: () => { owner = 'local-b' },
        change: () => { epoch++; rows = rows.map(row => ({ ...row, revision: 'r2' })) } }
}

describe('MCP login backend', () => {
    it('uses a live probe for connected and returns model-visible names only', async () => {
        const box = setup()
        const response = await box.dispatch(request, new AbortController().signal)
        expect(response.result).toEqual({ action: 'status', servers: [{ name: 'linear', revision: 'r1', transport: 'http', status: 'connected', tools: ['linear_search'] }] })
        expect(JSON.stringify(response)).not.toContain('https://')
    })

    it('continues to inventory later servers after a failed probe without exposing raw errors', async () => {
        const box = setup()
        vi.mocked(box.service.store.list).mockResolvedValue([
            { name: 'linear', revision: 'r1', url: 'https://linear.example/mcp', hasBearer: false },
            { name: 'docs', revision: 'r2', url: 'https://docs.example/mcp', hasBearer: false },
        ])
        vi.mocked(box.service.runtime.probe).mockRejectedValueOnce(new Error('Authorization: Bearer PRIVATE'))
        const result = await box.dispatch(request, new AbortController().signal)
        expect(JSON.stringify(result)).not.toContain('PRIVATE')
        expect(result.result).toMatchObject({ servers: [{ status: 'failed', tools: [] }, { status: 'connected', tools: ['docs_search'] }] })
    })

    it.each(['stop', 'change', 'switchOwner'] as const)('rejects late results after %s', async action => {
        const box = setup()
        vi.mocked(box.service.runtime.probe).mockImplementationOnce(async () => { box[action](); return { tools: [{ name: 'private' }] } })
        await expect(box.dispatch(request, new AbortController().signal)).rejects.toThrow()
    })

    it('never starts fallback when custody/approval adapter is missing', async () => {
        const box = setup()
        expect((await box.dispatch({ ...request, action: 'start', name: 'linear' }, new AbortController().signal)).result).toEqual({ action: 'start', name: 'linear', view: { state: 'unsupported' } })
        expect(box.service.runtime.probe).not.toHaveBeenCalled()
    })

    it('does not treat a model call or a declined card as human device approval', async () => {
        const box = setup()
        const device: ApprovedDeviceFallback = { authorize: vi.fn(async () => null), start: vi.fn(), complete: vi.fn() }
        const dispatch = createDesktopMcpLoginBackend(box.service, box.watch, device)
        expect((await dispatch({ ...request, action: 'start', name: 'linear' }, new AbortController().signal)).result).toMatchObject({ view: { state: 'approval_required' } })
        expect(device.start).not.toHaveBeenCalled()
    })

    it('requires fresh tools after a completion acknowledgement and preserves unknown outcomes', async () => {
        const box = setup()
        const device: ApprovedDeviceFallback = { authorize: async () => ({ approvalId: 'human-source' }), start: async () => ({ state: 'unknown' }), complete: async () => ({ state: 'connected', tools: ['fabricated_tool'] }) }
        const dispatch = createDesktopMcpLoginBackend(box.service, box.watch, device)
        expect((await dispatch({ ...request, action: 'start', name: 'linear' }, new AbortController().signal)).result).toMatchObject({ view: { state: 'unknown' } })
        expect(box.service.runtime.probe).not.toHaveBeenCalled()
        vi.mocked(box.service.runtime.probe).mockRejectedValue(new Error('probe failed'))
        expect((await dispatch({ ...request, action: 'complete', name: 'linear' }, new AbortController().signal)).result).toMatchObject({ view: { state: 'failed' } })
    })

    it('rejects model-selected endpoints, forged identity and already-aborted calls before probing', async () => {
        const box = setup()
        await expect(box.dispatch({ ...request, url: 'https://attacker.example' }, new AbortController().signal)).rejects.toThrow()
        await expect(box.dispatch({ ...request, identity: { ...identity, engineAgentId: 'other' } }, new AbortController().signal)).rejects.toThrow()
        await expect(box.dispatch(request, AbortSignal.abort())).rejects.toThrow()
        expect(box.service.runtime.probe).not.toHaveBeenCalled()
    })

    it('does not turn SSE metadata into a connected claim or run a stdio process', async () => {
        const box = setup()
        vi.mocked(box.service.store.list).mockResolvedValue([{ name: 'events', revision: 'r1', url: 'https://events.example', transport: 'sse', hasBearer: false }])
        expect((await box.dispatch(request, new AbortController().signal)).result).toMatchObject({ servers: [{ transport: 'sse', status: 'unavailable', tools: [] }] })
        expect(box.service.runtime.probe).not.toHaveBeenCalled()
    })
})

it('never trusts the device completion inventory in place of the actual configured connection', async () => {
    const box = setup()
    const device: ApprovedDeviceFallback = { authorize: async () => ({ approvalId: 'human-source' }), start: async () => ({ state: 'unsupported' }), complete: async () => ({ state: 'connected', tools: ['invented_name'] }) }
    const dispatch = createDesktopMcpLoginBackend(box.service, box.watch, device)
    expect((await dispatch({ ...request, action: 'complete', name: 'linear' }, new AbortController().signal)).result).toMatchObject({ view: { state: 'connected', tools: ['linear_search'] } })
})

it('forwards the exact immutable attempt identity and never retries an uncertain device effect', async () => {
    const box = setup()
    const start = vi.fn(async () => ({ state: 'unknown' as const }))
    const device: ApprovedDeviceFallback = { authorize: async () => ({ approvalId: 'human-source' }), start, complete: async () => ({ state: 'no_pending' }) }
    const dispatch = createDesktopMcpLoginBackend(box.service, box.watch, device)
    await dispatch({ ...request, action: 'start', name: 'linear' }, new AbortController().signal)
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]).toEqual([expect.objectContaining({ identity, requestId: 'call-a', approvalId: 'human-source', owner: 'local-a', name: 'linear', revision: 'r1', url: 'https://linear.example/mcp' }), expect.any(AbortSignal)])
})
