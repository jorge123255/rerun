import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import type { DesktopServiceAccountMutation } from '@rerun/contracts'
import { accountHarness, bearerManifest, FIXTURE_TOKEN, mcpResponse } from './regression-harness'

type Harness = ReturnType<typeof accountHarness>

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
}

function installInput(h: Harness, values: Record<string, string> = { TOKEN: FIXTURE_TOKEN }, kind: 'new' | 'additional' = 'new'): DesktopServiceAccountMutation {
    return { action: 'install', requestId: h.requestId(), intent: { kind, slug: 'fixture' }, authMethodId: 'token', values }
}

function workspaceManifest() {
    const manifest = bearerManifest()
    const method = manifest.authMethods[0]!
    return bearerManifest('fixture', {
        authMethods: [{
            ...method,
            inputs: [...method.inputs, { key: 'WORKSPACE', label: 'Workspace', secret: false, required: true }],
            mcpServers: [{ ...method.mcpServers[0], headers: { 'X-Api-Key': 'Token ${input.TOKEN}', 'X-Workspace': '${input.WORKSPACE}' } }],
        }],
    })
}

async function healthyAccount() {
    const h = accountHarness()
    h.manifests.fixture = bearerManifest()
    h.setGranted(true)
    const life = h.lifecycle()
    const saved = await life.mutate(h.binding, installInput(h), h.signal())
    const probe = await life.mutate(h.binding, {
        action: 'probe', requestId: h.requestId(),
        intent: { kind: 'existing', accountKey: saved.accountKey!, expectedRevision: saved.revision! },
    }, h.signal())
    expect(probe.account?.toolNames).toEqual(['fixture_echo'])
    h.networkCalls.length = 0
    return { h, life, saved }
}

it('reconfigures one existing installation, changes its public fields, and replays the same revision after restart', async () => {
    const h = accountHarness()
    h.manifests.fixture = workspaceManifest()
    const life = h.lifecycle()
    const base = await life.mutate(h.binding, installInput(h, { TOKEN: FIXTURE_TOKEN, WORKSPACE: 'base' }), h.signal())
    const siblingToken = 'sibling-private-fixture'
    const sibling = await life.mutate(h.binding, installInput(h, { TOKEN: siblingToken, WORKSPACE: 'before' }, 'additional'), h.signal())
    const input: DesktopServiceAccountMutation = {
        action: 'reconfigure', requestId: h.requestId(),
        intent: { kind: 'existing', accountKey: sibling.accountKey!, expectedRevision: sibling.revision! },
        authMethodId: 'token', values: { TOKEN: '', WORKSPACE: 'after' },
    }
    const changed = await life.mutate(h.binding, input, h.signal())
    expect(changed.installationId).toBe(sibling.installationId)
    expect(changed.revision).not.toBe(sibling.revision)
    expect(changed.account?.publicInputs).toEqual({ WORKSPACE: 'after' })
    expect(await h.secrets.read(h.binding.coworkerId, sibling.installationId!, sibling.revision!)).toBeNull()
    expect(await h.secrets.read(h.binding.coworkerId, changed.installationId!, changed.revision!)).toEqual({
        headers: { 'X-Api-Key': `Token ${siblingToken}`, 'X-Workspace': 'after' }, inputs: { TOKEN: siblingToken },
    })
    const restarted = h.lifecycle()
    expect(await restarted.mutate(h.binding, input, h.signal())).toMatchObject({
        installationId: changed.installationId, revision: changed.revision, accountKey: changed.accountKey,
    })
    expect(await h.installs.list(h.binding.coworkerId)).toHaveLength(2)
    expect(await h.installs.read(h.binding.coworkerId, 'fixture')).toMatchObject({
        id: base.installationId, revision: base.revision, plan: { publicInputs: { WORKSPACE: 'base' } },
    })
    expect((await h.secrets.read(h.binding.coworkerId, base.installationId!, base.revision!))?.inputs.TOKEN).toBe(FIXTURE_TOKEN)
    expect(h.networkCalls).toHaveLength(0)
})

it('resumes an allocated reconfigure after secret sealing without allocating another revision', async () => {
    const h = accountHarness()
    h.manifests.fixture = bearerManifest()
    const life = h.lifecycle()
    const first = await life.mutate(h.binding, installInput(h), h.signal())
    const rotated = 'rotated-private-fixture'
    const input: DesktopServiceAccountMutation = {
        action: 'reconfigure', requestId: h.requestId(),
        intent: { kind: 'existing', accountKey: first.accountKey!, expectedRevision: first.revision! },
        authMethodId: 'token', values: { TOKEN: rotated },
    }
    const update = h.installs.update.bind(h.installs)
    let failPublication = true
    h.installs.update = async (record, expectedRevision, bearer) => {
        if (failPublication && record.id === first.installationId && record.revision !== first.revision) {
            failPublication = false
            throw new Error('fixture publication interrupted')
        }
        return update(record, expectedRevision, bearer)
    }
    await expect(life.mutate(h.binding, input, h.signal())).rejects.toThrow('fixture publication interrupted')
    const reserved = (await h.reservations.list(h.binding.coworkerId)).find(row => row.requestId === input.requestId)!
    expect(reserved.installationId).toBe(first.installationId)
    expect(reserved.revision).not.toBe(first.revision)
    expect((await h.secrets.read(h.binding.coworkerId, first.installationId!, reserved.revision!))?.inputs.TOKEN).toBe(rotated)
    const recovered = await h.lifecycle().mutate(h.binding, input, h.signal())
    expect(recovered).toMatchObject({ installationId: first.installationId, revision: reserved.revision })
    expect((await h.installs.read(h.binding.coworkerId, first.accountKey!))?.revision).toBe(reserved.revision)
    expect(await h.installs.list(h.binding.coworkerId)).toHaveLength(1)
    expect(h.networkCalls).toHaveLength(0)
})

it('refuses an undiscovered tool even when another tool from that account is healthy', async () => {
    const { h, life, saved } = await healthyAccount()
    await expect(life.callTool(h.binding, saved.accountKey!, saved.revision!, { name: 'delete_everything', arguments: {} }, h.signal())).rejects.toThrow()
    expect(h.networkCalls).toHaveLength(0)
    await expect(life.callTool(h.binding, saved.accountKey!, saved.revision!, { name: 'echo', arguments: {} }, h.signal())).resolves.toHaveProperty('result')
    expect(h.networkCalls.some(call => call.init.method === 'POST' && JSON.parse(String(call.init.body)).method === 'tools/call')).toBe(true)
})

it.each(['grant', 'enabled', 'owner', 'revision'] as const)('rechecks %s after opening the credential bundle and before any request', async change => {
    const { h, life, saved } = await healthyAccount()
    const entered = deferred(), release = deferred()
    const read = h.secrets.read.bind(h.secrets)
    let held = false
    h.secrets.read = async (...args) => {
        const bundle = await read(...args)
        if (!held) {
            held = true
            entered.resolve()
            await release.promise
        }
        return bundle
    }
    const outcome = life.callTool(h.binding, saved.accountKey!, saved.revision!, { name: 'echo', arguments: {} }, h.signal())
        .then(() => 'completed', () => 'refused')
    await entered.promise
    try {
        if (change === 'grant') h.setGranted(false)
        if (change === 'enabled') h.setEnabled(false)
        if (change === 'owner') h.setEngine('replacement-engine')
        if (change === 'revision') {
            const row = (await h.installs.read(h.binding.coworkerId, saved.accountKey!))!
            await h.installs.update({ ...row, revision: h.requestId(), state: 'disconnected', toolNames: [] }, row.revision)
        }
    } finally { release.resolve() }
    expect(await outcome).toBe('refused')
    expect(h.networkCalls).toHaveLength(0)
})

it('does not dispatch a tool after its grant is revoked during initialize', async () => {
    const { h, life, saved } = await healthyAccount()
    h.setResponder(async (url, init) => {
        const response = await mcpResponse(url, init)
        if (init.method === 'POST' && JSON.parse(String(init.body)).method === 'initialize') h.setGranted(false)
        return response
    })
    await expect(life.callTool(h.binding, saved.accountKey!, saved.revision!, { name: 'echo', arguments: {} }, h.signal())).rejects.toThrow()
    const methods = h.networkCalls.filter(call => call.init.method === 'POST').map(call => JSON.parse(String(call.init.body)).method)
    expect(methods).toContain('initialize')
    expect(methods).not.toContain('tools/call')
})

it('does not publish a late tool reply after its grant is revoked', async () => {
    const { h, life, saved } = await healthyAccount()
    h.setResponder(async (url, init) => {
        const response = await mcpResponse(url, init)
        if (init.method === 'POST' && JSON.parse(String(init.body)).method === 'tools/call') h.setGranted(false)
        return response
    })
    await expect(life.callTool(h.binding, saved.accountKey!, saved.revision!, { name: 'echo', arguments: {} }, h.signal())).rejects.toThrow()
    expect(h.networkCalls.filter(call => call.init.method === 'POST' && JSON.parse(String(call.init.body)).method === 'tools/call')).toHaveLength(1)
})

it.each(['bearer', 'custom'] as const)('redacts raw secret inputs echoed without their %s header wrappers', async shape => {
    const h = accountHarness(), second = 'second-private-fixture'
    const manifest = bearerManifest(), method = manifest.authMethods[0]!
    h.manifests.fixture = shape === 'bearer' ? manifest : bearerManifest('fixture', {
        authMethods: [{
            ...method,
            inputs: [...method.inputs, { key: 'SECOND', label: 'Second', type: 'password', secret: true, required: true }],
            mcpServers: [{ ...method.mcpServers[0], headers: { 'X-Api-Key': 'Prefix ${input.TOKEN}:${input.SECOND} suffix' } }],
        }],
    })
    h.setGranted(true)
    const life = h.lifecycle()
    const saved = await life.mutate(h.binding, installInput(h, shape === 'bearer' ? { TOKEN: FIXTURE_TOKEN } : { TOKEN: FIXTURE_TOKEN, SECOND: second }), h.signal())
    await life.mutate(h.binding, {
        action: 'probe', requestId: h.requestId(), intent: { kind: 'existing', accountKey: saved.accountKey!, expectedRevision: saved.revision! },
    }, h.signal())
    const secrets = shape === 'bearer' ? [FIXTURE_TOKEN] : [FIXTURE_TOKEN, second]
    h.setResponder(async (url, init) => {
        if (init.method !== 'POST') return mcpResponse(url, init)
        const request = JSON.parse(String(init.body))
        if (request.method !== 'tools/call') return mcpResponse(url, init)
        return Response.json({ jsonrpc: '2.0', id: request.id, result: {
            content: [{ type: 'text', text: `Individual credentials: ${secrets.join(' and ')}.` }],
            structuredContent: { [FIXTURE_TOKEN]: { nested: secrets } },
        } })
    })
    const result = await life.callTool(h.binding, saved.accountKey!, saved.revision!, { name: 'echo', arguments: {} }, h.signal())
    const encoded = JSON.stringify(result)
    for (const secret of secrets) expect(encoded).not.toContain(secret)
    expect(encoded).toContain('[REDACTED]')
    expect(result.result.content).toEqual([{ type: 'text', text: `Individual credentials: ${secrets.map(() => '[REDACTED]').join(' and ')}.` }])
})
