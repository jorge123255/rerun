import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, unlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { seedLegacyCatalog, createWorkspace, readCatalog } from '../workspaces/catalog.mjs'
import { workspaceDirectory } from '../workspaces/paths.mjs'
import { createRemoteMachineStore } from './store.mjs'
import { fixtureCustody, actor, remoteIdentity, FIXTURE_KEY } from './fixtures.mjs'
test('temporary-directory storage consumes canonical workspaces, keeps secrets sealed and refuses linked files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-remote-source-fixture-'))
    try {
        await seedLegacyCatalog(root, actor.installId)
        const before = await readFile(join(root, 'workspaces', 'catalog.json'), 'utf8')
        const store = createRemoteMachineStore({ dataRoot: root, installId: actor.installId, workspaceId: 1 })
        assert.equal((await store.read()).connection, null)
        await assert.rejects(readFile(join(workspaceDirectory(root, 1), 'remote-machine.json')), { code: 'ENOENT' })
        const connection = { connectionId: randomUUID(), revision: randomUUID(), workspaceId: 1, address: 'https://server.example', identity: remoteIdentity,
            tlsPin: 'a'.repeat(64), health: { state: 'not_checked', checkedAt: null, commit: null, activeAgents: null, reason: null }, sealedKey: null }
        connection.sealedKey = await fixtureCustody().seal(actor, connection, FIXTURE_KEY)
        await store.mutate(state => { state.connection = connection })
        const file = join(workspaceDirectory(root, 1), 'remote-machine.json'), bytes = await readFile(file, 'utf8')
        assert.equal(bytes.includes(FIXTURE_KEY), false); assert.equal(await readFile(join(root, 'workspaces', 'catalog.json'), 'utf8'), before)
        const copy = join(root, 'private-copy.json'); await link(file, copy)
        await assert.rejects(store.read()); await unlink(copy)
        await unlink(file); await symlink(copy, file); await assert.rejects(store.read())
    } finally { await rm(root, { recursive: true, force: true }) }
})
test('another canonical workspace cannot adopt the saved credential envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-remote-owner-fixture-'))
    try {
        await seedLegacyCatalog(root, actor.installId)
        const created = await createWorkspace(root, actor.installId, { requestId: randomUUID(), name: 'Second workspace' })
        assert.equal(created.ok, true)
        const custody = fixtureCustody(), owner = { ...actor, workspaceId: created.workspace.workspaceId }
        const connection = { connectionId: randomUUID(), revision: randomUUID(), address: 'https://server.example', identity: null, tlsPin: null, sealedKey: null }
        connection.sealedKey = await custody.seal(actor, connection, FIXTURE_KEY)
        await assert.rejects(custody.use(owner, connection, async () => { assert.fail('foreign credentials must never be consumed') }))
        const { catalog } = await readCatalog(root, actor.installId)
        assert.equal(catalog.workspaces.length, 2)
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('sealed credential refuses destination, certificate or machine proof changes within the same revision', async () => {
    const custody = fixtureCustody()
    const connection = { connectionId: randomUUID(), revision: randomUUID(), address: 'https://server.example', identity: remoteIdentity, tlsPin: 'a'.repeat(64), sealedKey: null }
    connection.sealedKey = await custody.seal(actor, connection, FIXTURE_KEY)
    for (const changed of [{ address: 'https://another.example' }, { tlsPin: 'b'.repeat(64) }, { identity: { ...remoteIdentity, machineId: randomUUID() } }]) {
        await assert.rejects(custody.use(actor, { ...connection, ...changed }, async () => { assert.fail('changed destination must not consume the key') }))
    }
    assert.equal(await custody.use(actor, connection, async key => key === FIXTURE_KEY), true)
})
