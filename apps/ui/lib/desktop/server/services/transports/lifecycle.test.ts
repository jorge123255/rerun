import { describe, expect, it } from 'vitest'
import { createServiceTransports } from './lifecycle'
import { harness, ref, requestId, run } from './regression-harness'
const signal = () => new AbortController().signal
const invocation = { requestId, toolCallId: 'tool-call', tool: 'work', arguments: {}, run }
describe('account transport authority and durable effects', () => {
    it('status and restart hydration never resolve secrets, connect or spawn', async () => {
        const h = harness()
        expect((await h.runtime.status(ref, signal())).state).toBe('unchecked')
        expect((await createServiceTransports(h.deps).status(ref, signal())).state).toBe('unchecked')
        expect(h.effects.discover).toBe(0); expect(h.effects.calls).toBe(0)
    })
    it.each(['sse', 'stdio'] as const)('requires separate Apps and %s execution grants', async transport => {
        const h = harness(transport)
        h.set({ appsGranted: false })
        await expect(h.runtime.discoverForRun(ref, requestId, run, signal())).rejects.toThrow('grant')
        h.set({ appsGranted: true, ...(transport === 'sse' ? { remoteGranted: false } : { programGranted: false }) })
        await expect(h.runtime.call(ref, invocation, signal())).rejects.toThrow('grant')
        expect(h.effects.calls).toBe(0)
    })
    it('checks immutable account, revision and trusted engine owner before effects', async () => {
        const h = harness()
        for (const bad of [{ ...ref, agentId: 'bob' }, { ...ref, installationId: '00000000-0000-4000-8000-000000000099' }, { ...ref, revision: '00000000-0000-4000-8000-000000000098' }]) await expect(h.runtime.call(bad, invocation, signal())).rejects.toThrow()
        await expect(h.runtime.call(ref, { ...invocation, run: { ...run, engineAgentId: 'foreign' } }, signal())).rejects.toThrow('changed')
        expect(h.effects.calls).toBe(0)
    })
    it('does not replay successful or lost-ack calls after restart', async () => {
        const h = harness()
        const first = await h.runtime.call(ref, invocation, signal())
        expect(JSON.stringify(first)).not.toContain('private-value')
        const restarted = createServiceTransports(h.deps)
        expect((await restarted.call(ref, invocation, signal())).receipt.outcome).toBe('uncertain')
        expect(h.effects.calls).toBe(1)
        expect(JSON.stringify([...h.claims.values()])).not.toContain('private-value')
    })
    it('settlement failure retains a tombstone instead of replaying', async () => {
        const h = harness(); h.settlementFailure(true)
        expect((await h.runtime.call(ref, invocation, signal())).receipt.outcome).toBe('uncertain')
        h.settlementFailure(false)
        expect((await createServiceTransports(h.deps).call(ref, invocation, signal())).receipt.outcome).toBe('uncertain')
        expect(h.effects.calls).toBe(1)
    })
    it('Stop interruption is uncertain and no duplicate invocation can run', async () => {
        const h = harness(); let release!: () => void
        h.hold(new Promise<void>(resolve => { release = resolve }))
        const controller = new AbortController(), pending = h.runtime.call(ref, invocation, controller.signal)
        await h.started
        controller.abort(); release()
        expect((await pending).receipt.outcome).toBe('uncertain')
        expect((await h.runtime.call(ref, invocation, signal())).receipt.outcome).toBe('uncertain')
        expect(h.effects.calls).toBe(1)
    })
    it('reconfiguration/credential change prevents publication of an old call', async () => {
        const h = harness(); let release!: () => void
        h.hold(new Promise<void>(resolve => { release = resolve }))
        const pending = h.runtime.call(ref, invocation, signal())
        await h.started
        h.set({ credentialGeneration: 'credential-2' }); release()
        expect((await pending).receipt.outcome).toBe('uncertain')
    })
    it('a failed drain stays retryable with the same Stop id', async () => {
        const h = harness(), command = { ...ref, requestId, action: 'stop' as const }
        h.closeFailure(true)
        expect((await h.runtime.control(command, signal())).state).toBe('closing')
        h.closeFailure(false)
        expect((await h.runtime.control(command, signal())).state).toBe('disconnected')
        expect(h.effects.drains).toBe(2)
    })
    it('history/reconcile is read-only; a duplicate reconnect cannot start a process', async () => {
        const h = harness('stdio'), command = { ...ref, requestId, action: 'reconnect' as const }
        expect((await h.runtime.control(command, signal())).state).toBe('healthy')
        expect((await createServiceTransports(h.deps).control(command, signal())).state).toBe('unchecked')
        expect((await h.runtime.reconcile(command, signal())).state).toBe('unchecked')
        expect(h.effects.discover).toBe(1)
    })
    it('release passes exact installation and run rather than owner-wide drain', async () => {
        const h = harness('stdio')
        await h.runtime.stopRun(ref, run, signal())
        expect(h.effects.runDrains).toBe(1); expect(h.effects.drains).toBe(0)
    })
    it('removal drains only the prior authority and leaves skill/secret deletion to root', async () => {
        const h = harness()
        const prior = await h.deps.authority(ref, 'close', undefined, signal())
        await h.runtime.beforeChange(prior, signal())
        expect(h.effects.drains).toBe(1)
        expect(Object.keys(h.runtime)).not.toContain('removeSkills')
    })
    it('a reused UUID with changed arguments cannot execute again', async () => {
        const h = harness()
        await h.runtime.call(ref, invocation, signal())
        expect((await h.runtime.call(ref, { ...invocation, arguments: { changed: true } }, signal())).receipt.outcome).toBe('uncertain')
        expect(h.effects.calls).toBe(1)
        expect((await h.runtime.call(ref, { ...invocation, requestId: '00000000-0000-4000-8000-000000000099' }, signal())).receipt.outcome).toBe('uncertain')
        expect(h.effects.calls).toBe(1)
    })
})
