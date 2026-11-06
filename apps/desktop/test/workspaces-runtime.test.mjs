import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSupervisor } from '../src/main/supervisor.mjs'
import { workspaceIdentity } from '../src/main/runtime.mjs'
import { seedLegacyCatalog, createWorkspace } from '../src/main/workspaces/index.mjs'

function identity() { return { installId: randomUUID(), encryptionKey: randomBytes(32).toString('hex'), engineApiKey: randomBytes(32).toString('hex') } }
test('workspace contexts keep legacy paths/keys and isolate the new runtime before spawning either child', async t => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-workspace-runtime-')), owner = identity(), launches = []
    t.after(() => rm(root, { recursive: true, force: true }))
    await seedLegacyCatalog(root, owner.installId)
    await createWorkspace(root, owner.installId, { requestId: randomUUID(), name: 'Other', iconCatalogId: null })
    let nextPort = 40100
    const supervisor = new RuntimeSupervisor({ root, identity: owner, bundle: { nodePath: 'synthetic', engineEntry: 'engine', uiHost: 'ui', buildId: 'qa' },
        port: async () => nextPort++, startupTimeout: 200, stopTimeout: 200,
        fetcher: async (url, options) => {
            const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'))
            if (url.endsWith('/internal/mcp')) return Response.json({ stopped: true })
            if (url.endsWith('/internal/workspaces')) {
                const body = JSON.parse(options.body)
                assert.equal(body.launchNonce, runtime.launchNonce); assert.equal(body.expectedWorkspaceId, runtime.workspaceId)
                assert.equal(options.headers.Authorization, `Bearer ${runtime.engine.apiKey}`)
                return Response.json({ ok: true, launchNonce: runtime.launchNonce, workspaceId: runtime.workspaceId, frozen: body.action === 'freeze', sequence: body.sequence, requestId: body.requestId })
            }
            return Response.json({ status: 'ready', protocolVersion: 1, launchNonce: runtime.launchNonce, workspaceId: runtime.workspaceId, buildId: runtime.buildId })
        },
        launch: (_node, args, options) => {
            launches.push({ args, env: options.env })
            const child = new EventEmitter()
            Object.assign(child, { exitCode: null, signalCode: null, connected: true, send(_message, cb) { this.exitCode = 0; this.emit('exit', 0, null); cb?.() } })
            if (args.includes('desktop-run')) {
                queueMicrotask(async () => {
                    const runtime = JSON.parse(await readFile(options.env.RERUN_DESKTOP_RUNTIME_FILE, 'utf8'))
                    child.emit('message', { type: 'ready', protocolVersion: 1, launchNonce: runtime.launchNonce, buildId: runtime.buildId })
                })
            }
            return child
        },
    })
    const actualRoot = await realpath(root), second = await supervisor.startFor(2, { name: 'Other', frozen: true })
    assert.equal(second.workspaceId, 2); assert.equal(second.installRoot, actualRoot)
    assert.equal(second.dataRoot, join(actualRoot, 'workspaces/2')); assert.equal(second.engineRoot, join(actualRoot, 'workspaces/2/engine'))
    for (const launched of launches) {
        assert.equal(launched.env.RERUN_DESKTOP_DATA_DIR, second.dataRoot)
        assert.equal(launched.env.RERUN_DESKTOP_WORKSPACE_ID, '2')
        assert.equal(launched.env.RERUN_DESKTOP_ADMISSIONS_FROZEN, '1')
        assert.notEqual(launched.env.RERUN_DESKTOP_SECRET_KEY, owner.encryptionKey)
    }
    assert.notEqual(second.engine.apiKey, owner.engineApiKey)
    await assert.rejects(supervisor.startFor(1), /Close the active workspace/)
    await supervisor.admissions('freeze', randomUUID()); await supervisor.admissions('unfreeze', randomUUID())
    await supervisor.stop()
    const legacy = await supervisor.startFor(1)
    assert.equal(legacy.dataRoot, actualRoot); assert.equal(legacy.engineRoot, join(actualRoot, 'workspaces/1/engine'))
    assert.equal(legacy.engine.apiKey, owner.engineApiKey)
    assert.equal(launches.at(-1).env.RERUN_DESKTOP_SECRET_KEY, owner.encryptionKey)
    await supervisor.stop()
})
test('provider custody is stable within a workspace and distinct across workspaces', () => {
    const owner = identity()
    assert.equal(workspaceIdentity(owner, 1), owner)
    assert.deepEqual(workspaceIdentity(owner, 2), workspaceIdentity(owner, 2))
    assert.notEqual(workspaceIdentity(owner, 2).encryptionKey, workspaceIdentity(owner, 3).encryptionKey)
    assert.notEqual(workspaceIdentity(owner, 2).engineApiKey, workspaceIdentity(owner, 3).engineApiKey)
})
test('health or admission acknowledgements from another workspace are refused', async () => {
    const supervisor = new RuntimeSupervisor({ bundle: {}, root: '', identity: identity(), startupTimeout: 1, fetcher: async () => Response.json({ status: 'ready', protocolVersion: 1, launchNonce: 'nonce', buildId: 'build', workspaceId: 1, ok: true, frozen: true }) })
    const runtime = { workspaceId: 2, launchNonce: 'nonce', buildId: 'build', app: { origin: 'http://127.0.0.1:40100' }, engine: { apiKey: 'synthetic' } }
    supervisor.runtime = runtime; supervisor.startupAbort = new AbortController()
    await assert.rejects(supervisor.waitForHealth({ exitCode: null, signalCode: null }, 'http://127.0.0.1:40100/health', {}, runtime), /timed out/)
    await assert.rejects(supervisor.admissions('freeze', randomUUID()), /not confirmed/)
})

test('cleanup uses a higher admission sequence after a lost freeze ACK and refuses the wrong sequence in a reply', async () => {
    const runtime = { workspaceId: 7, launchNonce: randomUUID(), app: { origin: 'http://127.0.0.1:40100' }, engine: { apiKey: 'synthetic' } }, requestId = randomUUID(), calls = []
    let mismatch = false
    const supervisor = new RuntimeSupervisor({ bundle: {}, root: '', identity: identity(), fetcher: async (_url, options) => {
        const body = JSON.parse(options.body); calls.push(body)
        if (body.sequence === 1) throw new Error('Lost freeze acknowledgement')
        return Response.json({ ok: true, workspaceId: 7, launchNonce: runtime.launchNonce, requestId: body.requestId, sequence: mismatch ? 1 : body.sequence, frozen: body.action === 'freeze' })
    } })
    supervisor.runtime = runtime
    await assert.rejects(supervisor.admissions('freeze', requestId), /Lost freeze acknowledgement/)
    await supervisor.admissions('unfreeze', requestId)
    assert.deepEqual(calls.map(body => [body.action, body.sequence, body.requestId]), [['freeze', 1, requestId], ['unfreeze', 2, requestId]])
    mismatch = true
    await assert.rejects(supervisor.admissions('freeze', requestId), /not confirmed/)
    assert.equal(calls.at(-1).sequence, 3)
})

test('recovery reuses only the exact runtime shutdown ACK and reaches an engine whose HTTP listener is already closed', async t => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-recovery-cached-drain-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const runtime = { workspaceId: 1, launchNonce: randomUUID(), app: { origin: 'http://127.0.0.1:40100' }, engine: { apiKey: 'synthetic' } }
    let engineStops = 0
    const supervisor = new RuntimeSupervisor({ bundle: {}, root, identity: identity(), stopTimeout: 1, fetcher: async () => { assert.fail('The already-drained UI HTTP listener is gone') } })
    supervisor.runtime = runtime; supervisor.toolsDrainedRuntime = runtime
    const engine = new EventEmitter()
    Object.assign(engine, { desktopRole: 'engine', exitCode: null, signalCode: null, connected: true,
        send(message, callback) { assert.equal(message.type, 'stop'); engineStops++; this.exitCode = 0; this.emit('exit', 0, null); callback?.() },
        kill() { assert.fail('Recovery must not force-kill an owned engine') },
    })
    supervisor.children.add(engine)
    await supervisor.prepareWorkspaceRecovery()
    assert.equal(engineStops, 1); assert.equal(supervisor.runtime, null); assert.equal(supervisor.children.size, 0)
    assert.equal(await supervisor.admissions('freeze', randomUUID()), true)
})

test('recovery keeps a partial live engine in custody when it cannot confirm exit', async t => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-recovery-unconfirmed-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const runtime = { workspaceId: 1, launchNonce: randomUUID(), app: { origin: 'http://127.0.0.1:40100' }, engine: { apiKey: 'synthetic' } }
    const supervisor = new RuntimeSupervisor({ bundle: {}, root, identity: identity(), stopTimeout: 1, fetcher: async () => { assert.fail('A cached exact-runtime drain does not need HTTP') } })
    supervisor.runtime = runtime; supervisor.toolsDrainedRuntime = runtime
    const engine = new EventEmitter()
    Object.assign(engine, { desktopRole: 'engine', exitCode: null, signalCode: null, connected: true, send(_message, callback) { callback?.() }, kill() { assert.fail('Unknown writers retain parent custody') } })
    supervisor.children.add(engine)
    await assert.rejects(supervisor.prepareWorkspaceRecovery(), /cleanup was not confirmed/)
    assert.equal(supervisor.runtime, runtime); assert.equal(supervisor.children.has(engine), true)
    assert.equal(supervisor.status.state, 'error')
})

test('another launch shutdown ACK cannot authorize recovery of a dead UI', async t => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-recovery-wrong-drain-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const runtime = { workspaceId: 1, launchNonce: randomUUID(), app: { origin: 'http://127.0.0.1:40100' }, engine: { apiKey: 'synthetic' } }
    let requests = 0
    const supervisor = new RuntimeSupervisor({ bundle: {}, root, identity: identity(), stopTimeout: 1, fetcher: async () => { requests++; throw new Error('Old UI is unreachable') } })
    supervisor.runtime = runtime; supervisor.toolsDrainedRuntime = { ...runtime, launchNonce: randomUUID() }
    await assert.rejects(supervisor.prepareWorkspaceRecovery(), /unreachable/)
    assert.equal(requests, 1); assert.equal(supervisor.runtime, runtime)
})
