import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { accountLifecycle, defaultToolGuard } from './lifecycle'
import { accountHarness, anonymousManifest, bearerManifest, FIXTURE_TOKEN, mcpResponse } from './regression-harness'
import { DESKTOP_SERVICE_ACCOUNT_MESSAGES as M } from '@rerun/contracts'
import type { ServiceManifest } from '@/lib/services/manifest'

type Harness = ReturnType<typeof accountHarness>

function installInput(h: Harness, slug: string, authMethodId: string, values: Record<string, string>, kind: 'new' | 'additional' = 'new') {
    return { action: 'install' as const, requestId: h.requestId(), intent: { kind, slug }, authMethodId, values }
}

it('saves anonymous and bearer accounts without probing, enabling Apps, or returning the token', async () => {
    const h = accountHarness()
    h.manifests.learn = anonymousManifest('learn', { name: 'Microsoft Learn' })
    h.manifests.fixture = bearerManifest()
    const life = h.lifecycle()
    const anonymous = await life.mutate(h.binding, installInput(h, 'learn', 'default', {}), h.signal())
    expect(anonymous.status).toBe('needs_config')
    expect(anonymous.message).toContain('Tool permission stays off')
    expect(h.networkCalls).toHaveLength(0)
    expect(await h.secrets.has(h.binding.coworkerId, anonymous.installationId!)).toBe(false)
    const bearer = await life.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: FIXTURE_TOKEN }), h.signal())
    expect(JSON.stringify(bearer)).not.toContain(FIXTURE_TOKEN)
    expect(JSON.stringify(await h.reservations.list(h.binding.coworkerId))).not.toContain(FIXTURE_TOKEN)
    const row = await h.installs.read(h.binding.coworkerId, 'fixture')
    expect(JSON.stringify(row?.plan)).not.toContain(FIXTURE_TOKEN)
    expect((await h.secrets.read(h.binding.coworkerId, bearer.installationId!, bearer.revision!))?.inputs.TOKEN).toBe(FIXTURE_TOKEN)
    expect(bearer.account?.configuredInputs).toEqual({ TOKEN: true })
    expect(bearer.account?.toolNames).toEqual([])
})

it('keeps a blank reconfigure and rejects a display mask without storing it', async () => {
    const h = accountHarness()
    h.manifests.fixture = bearerManifest()
    const life = h.lifecycle()
    const first = await life.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: FIXTURE_TOKEN }), h.signal())
    const again = await life.mutate(h.binding, { action: 'reconfigure', requestId: h.requestId(), intent: { kind: 'existing', accountKey: 'fixture', expectedRevision: first.revision! }, authMethodId: 'token', values: { TOKEN: '' } }, h.signal())
    expect((await h.secrets.read(h.binding.coworkerId, again.installationId!, again.revision!))?.inputs.TOKEN).toBe(FIXTURE_TOKEN)
    expect(again.revision).not.toBe(first.revision)
    await expect(life.mutate(h.binding, { action: 'reconfigure', requestId: h.requestId(), intent: { kind: 'existing', accountKey: 'fixture', expectedRevision: again.revision! }, authMethodId: 'token', values: { TOKEN: '••••' } }, h.signal())).rejects.toThrow(M.mask)
    expect((await h.secrets.read(h.binding.coworkerId, again.installationId!, again.revision!))?.inputs.TOKEN).toBe(FIXTURE_TOKEN)
    h.manifests.other = bearerManifest('other')
    await expect(life.mutate(h.binding, installInput(h, 'other', 'token', { TOKEN: '' }), h.signal())).rejects.toThrow(M.bearer)
    expect(await h.installs.read(h.binding.coworkerId, 'other')).toBeNull()
})

it('allocates one additional account, preserves the base, and does not reuse a removed id', async () => {
    const h = accountHarness()
    h.manifests.fixture = bearerManifest()
    const life = h.lifecycle()
    const base = await life.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: FIXTURE_TOKEN }), h.signal())
    await expect(life.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: FIXTURE_TOKEN }), h.signal())).rejects.toThrow(M.baseExists)
    const extra = await life.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: 'second-fixture-value' }, 'additional'), h.signal())
    expect(extra.accountKey).toBe('fixture@abc123')
    expect(extra.account?.label).toBe('Fixture 2')
    expect(extra.account?.instanceId).toBe('abc123')
    expect(await h.installs.read(h.binding.coworkerId, 'Fixture 2')).toBeNull()
    expect((await h.installs.read(h.binding.coworkerId, 'fixture'))?.id).toBe(base.installationId)
    expect((await h.secrets.read(h.binding.coworkerId, base.installationId!, base.revision!))?.inputs.TOKEN).toBe(FIXTURE_TOKEN)
    await life.mutate(h.binding, { action: 'remove', requestId: h.requestId(), intent: { kind: 'existing', accountKey: extra.accountKey!, expectedRevision: extra.revision! } }, h.signal())
    expect(await h.installs.read(h.binding.coworkerId, 'fixture@abc123')).toBeNull()
    expect((await h.secrets.read(h.binding.coworkerId, base.installationId!, base.revision!))?.inputs.TOKEN).toBe(FIXTURE_TOKEN)
    const replacement = await life.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: 'third-fixture-value' }, 'additional'), h.signal())
    expect(replacement.accountKey).toBe('fixture@def456')
    const guard = defaultToolGuard(h.installs)
    await expect(guard(h.binding.coworkerId, replacement.installationId!, ['fixture_echo'], h.signal())).rejects.toThrow(M.toolName)
    await expect(guard(h.binding.coworkerId, replacement.installationId!, ['fixture-def456_echo'], h.signal())).resolves.toBeUndefined()
})

it('refuses another account when the manifest is not multi-instance or the base is absent', async () => {
    const h = accountHarness()
    h.manifests.once = anonymousManifest('once')
    const life = h.lifecycle()
    await expect(life.mutate(h.binding, installInput(h, 'once', 'default', {}, 'additional'), h.signal())).rejects.toThrow(M.needBase)
    await life.mutate(h.binding, installInput(h, 'once', 'default', {}), h.signal())
    await expect(life.mutate(h.binding, installInput(h, 'once', 'default', {}, 'additional'), h.signal())).rejects.toThrow(M.notMulti)
})

it('reuses one allocated account for the same request and rejects a changed body', async () => {
    const h = accountHarness()
    h.manifests.fixture = anonymousManifest()
    const life = h.lifecycle()
    const input = installInput(h, 'fixture', 'default', {})
    let failed = false
    const create = h.installs.create.bind(h.installs)
    h.installs.create = async (record, bearer) => {
        if (!failed) {
            failed = true
            throw new Error(M.unwind)
        }
        return create(record, bearer)
    }
    await expect(life.mutate(h.binding, input, h.signal())).rejects.toThrow(M.unwind)
    const saved = await life.mutate(h.binding, input, h.signal())
    expect(await h.installs.list(h.binding.coworkerId)).toHaveLength(1)
    const replay = await life.mutate(h.binding, input, h.signal())
    expect(replay.installationId).toBe(saved.installationId)
    await expect(life.mutate(h.binding, { ...input, values: { EXTRA: 'changed' } }, h.signal())).rejects.toThrow(M.reused)
    const restarted = h.lifecycle()
    const recovered = await restarted.mutate(h.binding, input, h.signal())
    expect(recovered.installationId).toBe(saved.installationId)
    expect(await h.installs.list(h.binding.coworkerId)).toHaveLength(1)
})

it('joins one in-flight request and keeps a conflicting request out', async () => {
    const h = accountHarness()
    const manifest = anonymousManifest()
    let release: (value: ServiceManifest) => void = () => {}
    const gate = new Promise<ServiceManifest>(resolve => { release = resolve })
    h.deps.catalog.manifest = async () => gate
    const life = h.lifecycle()
    const input = installInput(h, 'fixture', 'default', {})
    const first = life.mutate(h.binding, input, h.signal())
    const second = life.mutate(h.binding, input, h.signal())
    expect(second).toBe(first)
    expect(() => life.mutate(h.binding, { ...input, values: { EXTRA: 'other' } }, h.signal())).toThrow(M.reused)
    release(manifest)
    await first
    expect(await h.installs.list(h.binding.coworkerId)).toHaveLength(1)
})

it('does not let a stale remove win a secret reconfigure race', async () => {
    const h = accountHarness()
    h.manifests.fixture = bearerManifest()
    const life = h.lifecycle()
    const first = await life.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: FIXTURE_TOKEN }), h.signal())
    const write = h.secrets.write.bind(h.secrets)
    let arm: { entered: () => void; gate: Promise<void> } | null = null
    h.secrets.write = async input => {
        if (arm) {
            const current = arm
            arm = null
            current.entered()
            await current.gate
        }
        return write(input)
    }
    let enteredResolve: () => void = () => {}
    let gateResolve: () => void = () => {}
    const entered = new Promise<void>(resolve => { enteredResolve = resolve })
    const gate = new Promise<void>(resolve => { gateResolve = resolve })
    arm = { entered: enteredResolve, gate }
    const reconfigure = life.mutate(h.binding, { action: 'reconfigure', requestId: h.requestId(), intent: { kind: 'existing', accountKey: 'fixture', expectedRevision: first.revision! }, authMethodId: 'token', values: { TOKEN: 'rotated-fixture-value' } }, h.signal())
    await entered
    const removal = life.mutate(h.binding, { action: 'remove', requestId: h.requestId(), intent: { kind: 'existing', accountKey: 'fixture', expectedRevision: first.revision! } }, h.signal())
    gateResolve()
    const saved = await reconfigure
    await expect(removal).rejects.toThrow(M.revision)
    expect((await h.secrets.read(h.binding.coworkerId, saved.installationId!, saved.revision!))?.inputs.TOKEN).toBe('rotated-fixture-value')
    expect(await h.installs.read(h.binding.coworkerId, 'fixture')).not.toBeNull()
})

it('disconnects one account locally, leaves a sibling, and does not call the network', async () => {
    const h = accountHarness()
    h.manifests.fixture = bearerManifest()
    const life = h.lifecycle()
    const base = await life.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: FIXTURE_TOKEN }), h.signal())
    const extra = await life.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: 'second-fixture-value' }, 'additional'), h.signal())
    const disconnected = await life.mutate(h.binding, { action: 'disconnect', requestId: h.requestId(), intent: { kind: 'existing', accountKey: extra.accountKey!, expectedRevision: extra.revision! } }, h.signal())
    expect(disconnected.status).toBe('disconnected')
    expect(disconnected.message).toBe(M.removed)
    expect(h.networkCalls).toHaveLength(0)
    expect(await h.secrets.has(h.binding.coworkerId, extra.installationId!)).toBe(false)
    expect((await h.secrets.read(h.binding.coworkerId, base.installationId!, base.revision!))?.inputs.TOKEN).toBe(FIXTURE_TOKEN)
    await expect(life.mutate(h.binding, { action: 'disconnect', requestId: h.requestId(), intent: { kind: 'existing', accountKey: base.accountKey!, expectedRevision: base.revision! } }, h.signal())).resolves.toMatchObject({ status: 'disconnected' })
    await expect(life.mutate(h.binding, { action: 'disconnect', requestId: h.requestId(), intent: { kind: 'existing', accountKey: base.accountKey!, expectedRevision: '00000000-0000-4000-8000-000000009999' } }, h.signal())).rejects.toThrow(M.revision)
})

it('returns gone for a missing disconnect and blocks a removed instance id', async () => {
    const h = accountHarness()
    h.manifests.fixture = bearerManifest()
    const life = h.lifecycle()
    await life.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: FIXTURE_TOKEN }), h.signal())
    const missing = await life.mutate(h.binding, { action: 'disconnect', requestId: h.requestId(), intent: { kind: 'existing', accountKey: 'fixture@abc123', expectedRevision: '00000000-0000-4000-8000-000000000111' } }, h.signal())
    expect(missing).toMatchObject({ status: 'unknown', message: M.gone })
    const removed = await life.mutate(h.binding, { action: 'remove', requestId: h.requestId(), intent: { kind: 'existing', accountKey: 'fixture@abc123', expectedRevision: '00000000-0000-4000-8000-000000000111' } }, h.signal())
    expect(removed.status).toBe('removed')
    const extra = await life.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: 'second-fixture-value' }, 'additional'), h.signal())
    expect(extra.accountKey).toBe('fixture@def456')
})

it('probes only the selected account and does not replay a cancelled or already probing request', async () => {
    const h = accountHarness()
    h.manifests.fixture = bearerManifest()
    const life = h.lifecycle()
    const saved = await life.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: FIXTURE_TOKEN }), h.signal())
    const probe = { action: 'probe' as const, requestId: h.requestId(), intent: { kind: 'existing' as const, accountKey: saved.accountKey!, expectedRevision: saved.revision! } }
    const denied = await life.mutate(h.binding, probe, h.signal())
    expect(denied.message).toBe(M.grant)
    expect(h.networkCalls).toHaveLength(0)
    h.setGranted(true)
    const controller = new AbortController()
    h.setResponder(async () => {
        controller.abort()
        throw new Error(`leaked ${FIXTURE_TOKEN}`)
    })
    const cancelledProbe = { ...probe, requestId: h.requestId() }
    const cancelled = await life.mutate(h.binding, cancelledProbe, controller.signal)
    expect(cancelled).toMatchObject({ status: 'unknown', message: M.cancelled })
    expect(JSON.stringify(cancelled)).not.toContain(FIXTURE_TOKEN)
    const repeated = await life.mutate(h.binding, cancelledProbe, h.signal())
    expect(repeated.message).toBe(M.unknown)
    const callsAfterCancel = h.networkCalls.length
    expect(callsAfterCancel).toBe(1)
    const seeded = { ...probe, requestId: h.requestId() }
    const reservation = await h.reservations.begin(h.binding.coworkerId, seeded.requestId, h.installs.digest(h.binding.coworkerId, h.canonical(seeded)), '2026-01-01T00:00:00.000Z')
    await h.reservations.save({ ...reservation, phase: 'probing', accountKey: saved.accountKey!, revision: saved.revision! }, 'reserved')
    expect((await life.mutate(h.binding, seeded, h.signal())).message).toBe(M.unknown)
    expect(h.networkCalls).toHaveLength(callsAfterCancel)
    h.setResponder(mcpResponse)
    const live = { ...probe, requestId: h.requestId() }
    const probed = await life.mutate(h.binding, live, h.signal())
    expect(probed.account?.toolNames).toEqual(['fixture_echo'])
    const beforeReplay = h.networkCalls.length
    expect((await life.mutate(h.binding, live, h.signal())).status).toBe('probed')
    expect(h.networkCalls).toHaveLength(beforeReplay)
    const called = await life.callTool(h.binding, saved.accountKey!, saved.revision!, { name: 'echo', arguments: {} }, h.signal())
    expect(JSON.stringify(called)).not.toContain(FIXTURE_TOKEN)
    expect(JSON.stringify(called)).toContain('[REDACTED]')
    h.setNow('2026-01-01T00:02:00.000Z')
    expect((await life.list(h.binding, h.signal()))[0].toolNames).toEqual([])
    await expect(life.callTool(h.binding, saved.accountKey!, saved.revision!, { name: 'echo', arguments: {} }, h.signal())).rejects.toThrow(M.probeFailed)
    h.setGranted(false)
    await expect(life.callTool(h.binding, saved.accountKey!, saved.revision!, { name: 'echo', arguments: {} }, h.signal())).rejects.toThrow(M.grant)
})

it('refuses a stale engine and explains the account limit', async () => {
    const h = accountHarness()
    h.manifests.fixture = bearerManifest()
    const life = h.lifecycle()
    const saved = await life.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: FIXTURE_TOKEN }), h.signal())
    h.setEngine('engine-2')
    await expect(life.mutate(h.binding, { action: 'reconfigure', requestId: h.requestId(), intent: { kind: 'existing', accountKey: 'fixture', expectedRevision: saved.revision! }, authMethodId: 'token', values: { TOKEN: '' } }, h.signal())).rejects.toThrow(M.owner)
    expect((await h.secrets.read(h.binding.coworkerId, saved.installationId!, saved.revision!))?.inputs.TOKEN).toBe(FIXTURE_TOKEN)
    h.setEngine('engine-1')
    for (let index = 0; index < 63; index += 1) {
        const slug = `app${index}`
        h.manifests[slug] = anonymousManifest(slug)
        await life.mutate(h.binding, installInput(h, slug, 'default', {}), h.signal())
    }
    const pending = h.requestId()
    const reservation = await h.reservations.begin(h.binding.coworkerId, pending, 'other-fingerprint', '2026-01-01T00:00:00.000Z')
    await h.reservations.save({ ...reservation, phase: 'allocated', accountKey: 'pending-app', installationId: '00000000-0000-4000-8000-000000000777', revision: '00000000-0000-4000-8000-000000000778' }, 'reserved')
    h.manifests.overflow = anonymousManifest('overflow')
    await expect(life.mutate(h.binding, installInput(h, 'overflow', 'default', {}), h.signal())).rejects.toThrow(M.limit)
    expect(await h.installs.read(h.binding.coworkerId, 'overflow')).toBeNull()
})

it('keeps a shared usage-skill bundle until nothing else references it', async () => {
    const h = accountHarness()
    const skill = { name: 'Use', description: 'Read tools', body: 'Read the account tools.' }
    h.manifests.fixture = bearerManifest('fixture', { skills: [skill] })
    const life = accountLifecycle({ ...h.deps, skills: undefined })
    await expect(life.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: FIXTURE_TOKEN }), h.signal())).rejects.toThrow(M.skillsUnavailable)
    expect(await h.installs.list(h.binding.coworkerId)).toHaveLength(0)
    const withSkills = h.lifecycle()
    h.skills.create = async () => ({ slug: 'svc-shared', directoryIdentity: 'dir:svc-shared', contentHash: 'fixture-content-hash', manifestVersion: '1' })
    const base = await withSkills.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: FIXTURE_TOKEN }), h.signal())
    const extra = await withSkills.mutate(h.binding, installInput(h, 'fixture', 'token', { TOKEN: 'second-fixture-value' }, 'additional'), h.signal())
    await withSkills.mutate(h.binding, { action: 'remove', requestId: h.requestId(), intent: { kind: 'existing', accountKey: extra.accountKey!, expectedRevision: extra.revision! } }, h.signal())
    expect(h.removedSkills).toEqual([])
    expect(await h.installs.read(h.binding.coworkerId, base.accountKey!)).not.toBeNull()
    h.setSkillReferences(1)
    await withSkills.mutate(h.binding, { action: 'remove', requestId: h.requestId(), intent: { kind: 'existing', accountKey: base.accountKey!, expectedRevision: base.revision! } }, h.signal())
    expect(h.removedSkills).toEqual([])
    expect(await h.installs.read(h.binding.coworkerId, base.accountKey!)).toBeNull()
})
