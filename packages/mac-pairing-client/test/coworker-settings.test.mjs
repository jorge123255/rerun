import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMacPairingClient, createMacSessionStore, createMemoryStorage } from '../src/index.mjs'

const uuid = '4ce8e801-9bbd-4c6e-8221-2e326471724c'

async function paired(reply) {
    const storage = createMemoryStorage()
    const calls = []
    const origin = 'https://192.168.1.10:10421'
    const certificateFingerprint = 'c'.repeat(64)
    await createMacSessionStore(storage).write({
        kind: 'rerun-mac-phone-pairing', status: 'approved', credential: 'x'.repeat(43),
        certificateFingerprint, origin, workspaceId: 7, deviceId: 'settings-phone',
    })
    const client = createMacPairingClient({ storage, pinnedFetch: async (url, pin, init) => {
        assert.equal(new URL(url).origin, origin)
        assert.equal(pin, certificateFingerprint)
        assert.equal(init.headers.Authorization, 'Bearer ' + 'x'.repeat(43))
        calls.push({ resource: url.slice(origin.length), method: init.method, body: init.body && JSON.parse(init.body) })
        return reply()
    } })
    return { calls, client }
}

test('settings writes use only the paired workspace and the named Mac operation', async () => {
    const { calls, client } = await paired(() => Response.json({ ok: true }))
    const changes = [
        ['model', 'PATCH', { action: 'follow-workspace' }],
        ['model', 'PATCH', { action: 'coworker', connectionId: 'local', model: 'small' }],
        ['effort', 'PUT', { connectionId: 'local', model: 'small', effort: null }],
        ['tools', 'PATCH', { group: 'rerun', id: 'callAgent', enabled: true }],
        ['call-targets', 'PATCH', { targetAgentIds: [uuid], expectedTargetAgentIds: [] }],
        ['settings', 'PATCH', { description: 'Updated description' }],
        ['name', 'PATCH', { name: 'Avery' }],
        ['enabled', 'PATCH', { enabled: false }],
        ['box', 'POST', { requestId: uuid, spaceId: uuid, expectedRevision: 4 }],
        ['setup', 'POST', { requestId: uuid, action: 'skip', expectedRevision: 'rev-3' }],
    ]
    for (const [field, method, body] of changes) {
        assert.deepEqual(await client.changeCoworkerSettings('agent-a', { field, body }), { ok: true })
        assert.deepEqual(calls.at(-1), { resource: '/api/mac-pairing/v1/workspaces/7/coworker-settings/' + field + '?agentId=agent-a', method, body })
    }
    for (const invalid of [
        { field: 'vault', body: { key: 'test' } },
        { field: 'name', body: { name: 'Avery', workspaceId: 2 } },
        { field: 'model', body: { action: 'conversation-follow', sessionId: 'another-chat' } },
    ]) await assert.rejects(client.changeCoworkerSettings('agent-a', invalid))
    assert.equal(calls.length, changes.length)
})

test('reads need pairing and writes preserve the authenticated Mac refusal', async () => {
    const { calls, client } = await paired(() => Response.json(
        { error: 'settings_refused', message: 'Stop the reply first.' }, { status: 409 },
    ))
    await assert.rejects(client.changeCoworkerSettings('agent-a', { field: 'enabled', body: { enabled: false } }),
        error => error.status === 409 && error.body.message === 'Stop the reply first.')
    await assert.rejects(client.readCoworkerSettings('agent-a'), error => error.status === 409)
    assert.deepEqual(calls[1], { resource: '/api/mac-pairing/v1/workspaces/7/coworker-settings?agentId=agent-a', method: 'GET', body: undefined })
    await client.clearMacSession()
    await assert.rejects(client.readCoworkerSettings('agent-a'), /not_paired/)
    assert.equal(calls.length, 2)
})

test('a malformed write receipt or settings snapshot is never taken as success', async () => {
    const { client } = await paired(() => Response.json({ result: 'done' }))
    await assert.rejects(client.changeCoworkerSettings('agent-a', { field: 'name', body: { name: 'Avery' } }), /invalid_settings_receipt/)
    await assert.rejects(client.readCoworkerSettings('agent-a'))
})

test('a settings read belongs to the requested coworker and returns only public fields', async () => {
    const view = {
        agentId: 'agent-a', name: 'Avery', description: '', enabled: true,
        settings: { soul: '', soulEditable: true, verbosity: 'normal', repository: null, workspaceReadEnabled: false,
            suggestedReplies: false, memoryEnabled: false, autoMemory: false, selfImprovementEnabled: false },
        model: { catalog: [], coworker: null, effective: { connectionId: null, provider: null, model: null, label: 'Workspace default', available: false } },
        board: { revision: 0, spaces: [], spaceId: null }, tools: { rerun: [], codex: [] },
        setup: { revision: 'one', required: null, pending: false, skipped: false, canStart: false, canSkip: false, completedAt: null },
        callTargets: { targets: [], allowedTargetIds: [] }, permissions: { changeSettings: false },
    }
    const { client } = await paired(() => Response.json({ ...view, diagnostics: 'fixture-only', settings: { ...view.settings, secretPreview: 'never display' } }))
    assert.deepEqual(await client.readCoworkerSettings('agent-a'), view)
    await assert.rejects(client.readCoworkerSettings('agent-b'), /invalid_settings_response/)
})
