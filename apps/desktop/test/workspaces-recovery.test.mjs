import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { seedLegacyCatalog, createWorkspace, renameWorkspace, readCatalog, createWorkspaceCoordinator, inspectWorkspacePath, ensureOwnedWorkspaceDirectory } from '../src/main/workspaces/index.mjs'
async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'rerun-workspace-recovery-')), installId = randomUUID()
    t.after(() => rm(root, { recursive: true, force: true }))
    await seedLegacyCatalog(root, installId)
    await createWorkspace(root, installId, { requestId: randomUUID(), name: 'Second', iconCatalogId: null })
    return { root, installId }
}
function ports(overrides = {}) {
    return { freezeAdmissions: async () => true, unfreezeAdmissions: async () => {}, flushDrafts: async () => ({ saved: true }), stopAndDrain: async () => {},
        bindAndStart: async workspaceId => ({ workspaceId }), verifyRuntimeIdentity: async () => true, ...overrides }
}
test('failed-after-drain survives coordinator recreation and only exact explicit recovery starts its target', async t => {
    const { root, installId } = await fixture(t), requestId = randomUUID(), starts = []
    const first = createWorkspaceCoordinator({ dataRoot: root, installId, ports: ports({ bindAndStart: async id => { starts.push(id); throw new Error('unavailable') } }) })
    assert.equal((await first.switchTo({ requestId, workspaceId: 2 })).ok, false)
    const recovered = createWorkspaceCoordinator({ dataRoot: root, installId, ports: ports({ bindAndStart: async id => { starts.push(id); return { workspaceId: id } } }) })
    const cold = await recovered.coldLaunchTarget()
    assert.equal(cold.ok, false); assert.equal(cold.receipt.phase, 'failed_after_drain'); assert.equal(cold.workspaceId, 2)
    assert.equal((await recovered.reconcile()).requiresManualRecovery, true)
    assert.equal((await recovered.switchTo({ requestId: randomUUID(), workspaceId: 1 })).code, 'busy')
    assert.equal((await recovered.recoverSwitch({ requestId, workspaceId: 1 })).code, 'duplicate_request')
    assert.deepEqual(starts, [2])
    const result = await recovered.recoverSwitch({ requestId, workspaceId: 2 })
    assert.equal(result.ok, true); assert.equal(result.receipt.requestId, requestId); assert.equal(result.receipt.phase, 'published')
    assert.deepEqual(starts, [2, 2]); assert.equal((await recovered.coldLaunchTarget()).workspaceId, 2)
})
test('a partial stop failure is durable uncertainty, never a safe before-drain rollback', async t => {
    const { root, installId } = await fixture(t)
    const coordinator = createWorkspaceCoordinator({ dataRoot: root, installId, ports: ports({ stopAndDrain: async () => { throw new Error('partial stop') } }) })
    assert.equal((await coordinator.switchTo({ requestId: randomUUID(), workspaceId: 2 })).ok, false)
    const next = await coordinator.coldLaunchTarget()
    assert.equal(next.ok, false); assert.equal(next.receipt.phase, 'failed_after_drain'); assert.equal(next.receipt.oldRuntimeClosed, false)
})
test('unreadable or tampered switch receipt blocks reads and startup instead of disappearing', async t => {
    const { root, installId } = await fixture(t), coordinator = createWorkspaceCoordinator({ dataRoot: root, installId, ports: ports() })
    await writeFile(join(root, 'workspaces/switches', randomUUID() + '.json'), '{broken', { mode: 0o600 })
    await assert.rejects(coordinator.reconcile(), /transition records/)
    await assert.rejects(coordinator.coldLaunchTarget(), /transition records/)
})
test('a request cannot be reused for another destination and late rename replay does not overwrite later state', async t => {
    const { root, installId } = await fixture(t), coordinator = createWorkspaceCoordinator({ dataRoot: root, installId, ports: ports() }), switchId = randomUUID()
    assert.equal((await coordinator.switchTo({ requestId: switchId, workspaceId: 2 })).ok, true)
    assert.equal((await coordinator.switchTo({ requestId: switchId, workspaceId: 1 })).code, 'duplicate_request')
    const firstId = randomUUID(), first = { requestId: firstId, workspaceId: 2, name: 'First' }
    assert.equal((await renameWorkspace(root, installId, first)).ok, true)
    assert.equal((await renameWorkspace(root, installId, { requestId: randomUUID(), workspaceId: 2, name: 'Second rename' })).ok, true)
    assert.equal((await renameWorkspace(root, installId, first)).workspace.name, 'First')
    assert.equal((await readCatalog(root, installId)).catalog.workspaces.find(x => x.workspaceId === 2).name, 'Second rename')
    assert.equal((await renameWorkspace(root, installId, { ...first, name: 'Conflict' })).code, 'duplicate_request')
})
test('create fingerprint fences another name or icon while exact retries keep the same identity', async t => {
    const { root, installId } = await fixture(t), requestId = randomUUID(), input = { requestId, name: 'Third', iconCatalogId: null }
    const first = await createWorkspace(root, installId, input)
    assert.equal((await createWorkspace(root, installId, { ...input, name: 'Other' })).code, 'duplicate_request')
    assert.deepEqual(await createWorkspace(root, installId, input), first)
})
test('legacy and engine/owner symlinks cannot be adopted', async t => {
    const { root, installId } = await fixture(t), outside = await mkdtemp(join(tmpdir(), 'rerun-workspace-foreign-'))
    t.after(() => rm(outside, { recursive: true, force: true }))
    const workspace = join(root, 'workspaces/2')
    await rm(join(workspace, 'engine'), { recursive: true }); await symlink(outside, join(workspace, 'engine'))
    assert.equal((await inspectWorkspacePath(root, installId, 2)).status, 'corrupt')
    await assert.rejects(ensureOwnedWorkspaceDirectory(root, installId, 2))
    assert.deepEqual(await readdir(outside), [])
    const legacy = join(root, 'workspaces/1')
    await rm(join(legacy, 'owner.json'))
    assert.equal((await inspectWorkspacePath(root, installId, 1)).status, 'foreign')
    await assert.rejects(ensureOwnedWorkspaceDirectory(root, installId, 1))
})
test('read-only reconciliation cannot recreate a missing selection', async t => {
    const { root, installId } = await fixture(t), selection = join(root, 'workspaces/selected.json')
    await rm(selection)
    const coordinator = createWorkspaceCoordinator({ dataRoot: root, installId, ports: ports() })
    await assert.rejects(coordinator.reconcile())
    await assert.rejects(readFile(selection))
})
