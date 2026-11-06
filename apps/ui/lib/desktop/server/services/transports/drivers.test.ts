import { describe, expect, it, vi } from 'vitest'
import { canonicalSseServiceDriver, canonicalProgramServiceDriver } from './drivers'
import type { createSseRuntime } from '../../mcp-sse/runtime'
import { harness, ref, run, requestId } from './regression-harness'
const signal = new AbortController().signal
const sseRef = { agentId: ref.agentId, serverId: 'server', name: 'example', expectedRevision: ref.revision }
describe('canonical lifecycle dispatch', () => {
    it('routes legacy SSE to the same core, including uncertain results and exact Stop', async () => {
        const h = harness(), authority = await h.deps.authority(ref, 'call', run, signal)
        const dispose = vi.fn(async () => {}), call = vi.fn(async () => ({ status: 'uncertain' })), releaseServerRun = vi.fn(async () => {})
        const driver = canonicalSseServiceDriver({ call, dispose } as unknown as ReturnType<typeof createSseRuntime>, { reference: async () => sseRef, releaseServerRun })
        await expect(driver.call({ authority, signal, guard: async () => {}, material: { transport: 'sse', url: 'https://example.org/sse' } }, { requestId, toolCallId: 'call', tool: 'work', arguments: {}, run })).rejects.toThrow('unknown')
        await driver.drain(authority, signal); await driver.releaseRun(authority, run, signal)
        expect(dispose).toHaveBeenCalledWith(ref.agentId, 'server'); expect(releaseServerRun).toHaveBeenCalledWith(sseRef, run, signal)
        expect(call).toHaveBeenCalledTimes(1)
    })
    it('checks account generations before and after program dispatch, without spawning', async () => {
        let checks = 0
        const h = harness('stdio'), authority = await h.deps.authority(ref, 'call', run, signal), context = { authority, signal, guard: async () => { checks++ }, material: { transport: 'stdio' as const, executable: '/usr/local/bin/example', args: [], env: {}, executableIdentity: 'inode' } }
        const call = vi.fn(async () => ({ content: [] }))
        const driver = canonicalProgramServiceDriver({ status: async () => ({ state: 'unchecked', tools: [] }), discover: async () => ({ tools: [], observation: 'live' }), call, drain: async () => {}, releaseRun: async () => {} })
        await driver.call(context, { requestId, toolCallId: 'call', tool: 'work', arguments: {}, run })
        expect(checks).toBe(2); expect(call).toHaveBeenCalledTimes(1)
    })
})
