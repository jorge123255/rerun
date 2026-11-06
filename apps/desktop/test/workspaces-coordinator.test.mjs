import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
    createWorkspaceCoordinator,
    createWorkspace,
    seedLegacyCatalog,
    findOpenReceipt,
    isAfterDrainPhase,
} from '../src/main/workspaces/index.mjs'

function portsStub(overrides = {}) {
    let frozen = false
    let runtime = { workspaceId: 1, launchNonce: 'n', dataRoot: 'x' }
    return {
        readStatus: () => ({ state: 'ready' }),
        readRuntimeIdentity: () => runtime,
        isQuitInProgress: () => false,
        freezeAdmissions: async () => { frozen = true; return true },
        unfreezeAdmissions: async () => { frozen = false },
        flushDrafts: async () => ({ saved: true }),
        stopAndDrain: async () => {},
        bindAndStart: async (workspaceId) => {
            runtime = { workspaceId, launchNonce: 'n2', dataRoot: 'x' }
            return runtime
        },
        verifyRuntimeIdentity: async (workspaceId) => runtime.workspaceId === workspaceId,
        _frozen: () => frozen,
        ...overrides,
    }
}

async function setup() {
    const dataRoot = await mkdtemp(join(tmpdir(), 'rerun-ws-coord-'))
    const installId = randomUUID()
    await seedLegacyCatalog(dataRoot, installId)
    const created = await createWorkspace(dataRoot, installId, { requestId: randomUUID(), name: 'Second', iconCatalogId: null })
    assert.equal(created.ok, true)
    return { dataRoot, installId, secondId: created.workspace.workspaceId }
}

test('switch orders freeze → flush → drain → start → verify → publish', async () => {
    const { dataRoot, installId, secondId } = await setup()
    const order = []
    const ports = portsStub({
        freezeAdmissions: async () => { order.push('freeze'); return true },
        flushDrafts: async () => { order.push('flush'); return { saved: true } },
        stopAndDrain: async () => { order.push('drain') },
        bindAndStart: async (workspaceId) => { order.push('start'); return { workspaceId, launchNonce: 'x', dataRoot } },
        verifyRuntimeIdentity: async (workspaceId) => { order.push('verify'); return workspaceId === secondId },
    })
    const coordinator = createWorkspaceCoordinator({ dataRoot, installId, ports })
    const result = await coordinator.switchTo({ requestId: randomUUID(), workspaceId: secondId })
    assert.equal(result.ok, true)
    assert.equal(result.receipt.phase, 'published')
    assert.deepEqual(order, ['freeze', 'flush', 'drain', 'start', 'verify'])
    const listed = await coordinator.list()
    assert.equal(listed.selection.workspaceId, secondId)
    await rm(dataRoot, { recursive: true, force: true })
})

test('draft flush failure rolls back before drain and unfreezes', async () => {
    const { dataRoot, installId, secondId } = await setup()
    let frozen = true
    const ports = portsStub({
        freezeAdmissions: async () => true,
        flushDrafts: async () => ({ saved: false }),
        unfreezeAdmissions: async () => { frozen = false },
        stopAndDrain: async () => { throw new Error('should not drain') },
    })
    const coordinator = createWorkspaceCoordinator({ dataRoot, installId, ports })
    const result = await coordinator.switchTo({ requestId: randomUUID(), workspaceId: secondId })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'draft_flush_failed')
    assert.equal(frozen, false)
    const open = await findOpenReceipt(dataRoot)
    assert.equal(open, null)
    await rm(dataRoot, { recursive: true, force: true })
})

test('missing bindAndStart authority fails closed', async () => {
    const { dataRoot, installId, secondId } = await setup()
    const ports = portsStub({ bindAndStart: undefined })
    const coordinator = createWorkspaceCoordinator({ dataRoot, installId, ports })
    const result = await coordinator.switchTo({ requestId: randomUUID(), workspaceId: secondId })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'authority_missing')
    assert.equal(result.authority, 'W1-A1')
    await rm(dataRoot, { recursive: true, force: true })
})

test('duplicate switch requestId is idempotent after publish', async () => {
    const { dataRoot, installId, secondId } = await setup()
    const ports = portsStub()
    const coordinator = createWorkspaceCoordinator({ dataRoot, installId, ports })
    const requestId = randomUUID()
    const first = await coordinator.switchTo({ requestId, workspaceId: secondId })
    assert.equal(first.ok, true)
    const second = await coordinator.switchTo({ requestId, workspaceId: secondId })
    assert.equal(second.ok, true)
    assert.equal(second.receipt.receiptId, first.receipt.receiptId)
    await rm(dataRoot, { recursive: true, force: true })
})

test('reconcile is non-effectful and reports after-drain recovery', async () => {
    const { dataRoot, installId, secondId } = await setup()
    let started = 0
    const ports = portsStub({
        bindAndStart: async (workspaceId) => {
            started += 1
            throw new Error('boom')
        },
    })
    const coordinator = createWorkspaceCoordinator({ dataRoot, installId, ports })
    const failed = await coordinator.switchTo({ requestId: randomUUID(), workspaceId: secondId })
    assert.equal(failed.ok, false)
    assert.equal(failed.code, 'runtime_start_failed')
    assert.equal(started, 1)
    const receipt = await findOpenReceipt(dataRoot)
    assert.equal(receipt.phase, 'failed_after_drain')
    assert.equal((await coordinator.coldLaunchTarget()).ok, false)
    const before = started
    const reconciled = await coordinator.reconcile()
    assert.equal(started, before)
    assert.equal(reconciled.selection.workspaceId, 1)
    assert.ok(isAfterDrainPhase('failed_after_drain'))
    await rm(dataRoot, { recursive: true, force: true })
})

test('coldLaunchTarget never starts a runtime', async () => {
    const { dataRoot, installId } = await setup()
    let started = 0
    const ports = portsStub({
        bindAndStart: async (workspaceId) => { started += 1; return { workspaceId, launchNonce: 'x', dataRoot } },
    })
    const coordinator = createWorkspaceCoordinator({ dataRoot, installId, ports })
    const target = await coordinator.coldLaunchTarget()
    assert.equal(target.ok, true)
    assert.equal(target.workspaceId, 1)
    assert.equal(started, 0)
    await rm(dataRoot, { recursive: true, force: true })
})

test('concurrent second switch is refused while busy', async () => {
    const { dataRoot, installId, secondId } = await setup()
    let release
    const gate = new Promise(resolve => { release = resolve })
    const ports = portsStub({
        freezeAdmissions: async () => { await gate; return true },
    })
    const coordinator = createWorkspaceCoordinator({ dataRoot, installId, ports })
    const first = coordinator.switchTo({ requestId: randomUUID(), workspaceId: secondId })
    // Allow the first switch to acquire the serialize gate and write accepted receipt.
    await new Promise(r => setTimeout(r, 20))
    const blocked = await coordinator.switchTo({ requestId: randomUUID(), workspaceId: secondId })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'busy')
    release()
    const done = await first
    assert.equal(done.ok, true)
    assert.ok(blocked.ok === false || blocked.receipt?.phase === 'published')
    await rm(dataRoot, { recursive: true, force: true })
})

test('a lost freeze ACK confirms exact-request rollback before allowing the original workspace to continue', async t => {
    const { dataRoot, installId, secondId } = await setup()
    t.after(() => rm(dataRoot, { recursive: true, force: true }))
    const requestId = randomUUID(), calls = []
    let frozen = false
    const coordinator = createWorkspaceCoordinator({ dataRoot, installId, ports: portsStub({
        freezeAdmissions: async context => { calls.push(['freeze', context.requestId]); frozen = true; throw new Error('ACK lost after freeze committed') },
        unfreezeAdmissions: async context => { calls.push(['unfreeze', context.requestId]); frozen = false },
        flushDrafts: async () => { assert.fail('No draft flush before freeze confirmation') },
        stopAndDrain: async () => { assert.fail('No close before freeze confirmation') },
    }) })
    assert.equal((await coordinator.switchTo({ requestId, workspaceId: secondId })).ok, false)
    assert.equal(frozen, false)
    assert.deepEqual(calls, [['freeze', requestId], ['unfreeze', requestId]])
    assert.equal((await coordinator.list()).openReceipt, null)
    assert.equal((await coordinator.coldLaunchTarget()).workspaceId, 1)
})

test('a lost cleanup ACK retains exact recovery across coordinator recreation even if unfreeze really happened', async t => {
    const { dataRoot, installId, secondId } = await setup()
    t.after(() => rm(dataRoot, { recursive: true, force: true }))
    const requestId = randomUUID()
    let frozen = false
    const coordinator = createWorkspaceCoordinator({ dataRoot, installId, ports: portsStub({
        freezeAdmissions: async () => { frozen = true; throw new Error('Lost freeze ACK') },
        unfreezeAdmissions: async () => { frozen = false; throw new Error('Lost cleanup ACK') },
    }) })
    assert.equal((await coordinator.switchTo({ requestId, workspaceId: secondId })).ok, false)
    assert.equal(frozen, false)
    const resumed = createWorkspaceCoordinator({ dataRoot, installId, ports: portsStub() })
    const blocked = await resumed.coldLaunchTarget()
    assert.equal(blocked.ok, false); assert.equal(blocked.receipt.requestId, requestId)
    assert.equal(blocked.receipt.phase, 'admissions_frozen')
    assert.equal((await resumed.switchTo({ requestId: randomUUID(), workspaceId: 1 })).code, 'busy')
    const recovered = await resumed.recoverSwitch({ requestId, workspaceId: secondId })
    assert.equal(recovered.ok, true); assert.equal(recovered.receipt.requestId, requestId)
})

test('a failed close never uses before-drain rollback to reopen admissions', async t => {
    const { dataRoot, installId, secondId } = await setup()
    t.after(() => rm(dataRoot, { recursive: true, force: true }))
    let unfreezes = 0
    const coordinator = createWorkspaceCoordinator({ dataRoot, installId, ports: portsStub({
        stopAndDrain: async () => { throw new Error('Partial close') },
        unfreezeAdmissions: async () => { unfreezes++ },
    }) })
    assert.equal((await coordinator.switchTo({ requestId: randomUUID(), workspaceId: secondId })).ok, false)
    assert.equal(unfreezes, 0)
    assert.equal((await coordinator.coldLaunchTarget()).receipt.phase, 'failed_after_drain')
})
