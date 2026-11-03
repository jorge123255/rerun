import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { RuntimeSupervisor } from '../src/main/supervisor.mjs'

const fixture = fileURLToPath(new URL('./service-fixture.mjs', import.meta.url))
const identity = () => ({ installId: randomUUID(), engineApiKey: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') })

test('real supervised processes require authenticated nonce readiness and Quit removes owned children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-supervisor-'))
    const children = []
    const supervisor = new RuntimeSupervisor({
        root, identity: identity(), bundle: { nodePath: process.execPath, uiRoot: root, engineEntry: 'fixture', buildId: 'example-build' },
        launch: (command, args, options) => {
            const child = spawn(command, [fixture], { ...options, env: { ...options.env, FIXTURE_KIND: args.includes('desktop-run') ? 'engine' : 'ui' } })
            children.push(child)
            return child
        }, startupTimeout: 3000, stopTimeout: 1000,
    })
    try {
        const runtime = await supervisor.start()
        assert.equal(supervisor.status.state, 'ready')
        assert.equal(children.length, 2)
        assert.equal((await fetch(`${runtime.engine.origin}/health`)).status, 401)
        assert.equal((await fetch(`${runtime.app.origin}/api/desktop/health`)).status, 401)
        await supervisor.stop()
        assert(children.every(child => child.exitCode === 0))
        assert.equal(supervisor.children.size, 0)
        await assert.rejects(access(join(root, 'runtime.json')))
        const restarted = await supervisor.start()
        assert.notEqual(runtime.launchNonce, restarted.launchNonce)
        assert.equal(runtime.engine.apiKey, restarted.engine.apiKey)
    } finally { await supervisor.stop(); await rm(root, { recursive: true, force: true }) }
})

test('a lookalike health endpoint cannot pass readiness and failed launches leave no children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-false-health-'))
    const children = []
    const supervisor = new RuntimeSupervisor({
        root, identity: identity(), bundle: { nodePath: process.execPath, uiRoot: root, engineEntry: 'fixture', buildId: 'example-build' },
        launch: (command, _args, options) => {
            const child = spawn(command, [fixture], { ...options, env: { ...options.env, FIXTURE_BAD_NONCE: '1' } })
            children.push(child)
            return child
        }, startupTimeout: 200, stopTimeout: 1000,
    })
    try {
        await assert.rejects(supervisor.start(), /could not start/)
        assert.equal(supervisor.status.state, 'error')
        assert(children.every(child => child.exitCode === 0))
        assert.equal(supervisor.children.size, 0)
    } finally { await supervisor.stop(); await rm(root, { recursive: true, force: true }) }
})

test('a service crash stops its sibling instead of leaving a running hidden workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-child-crash-'))
    const supervisor = new RuntimeSupervisor({
        root, identity: identity(), bundle: { nodePath: process.execPath, uiRoot: root, engineEntry: 'fixture', buildId: 'example-build' },
        launch: (command, args, options) => spawn(command, [fixture], { ...options, env: { ...options.env, FIXTURE_KIND: args.includes('desktop-run') ? 'engine' : 'ui' } }),
        startupTimeout: 3000, stopTimeout: 1000,
    })
    try {
        await supervisor.start()
        const [first, sibling] = [...supervisor.children]
        const siblingExit = once(sibling, 'exit')
        first.kill('SIGKILL')
        await siblingExit
        assert.equal(supervisor.status.state, 'error')
        assert.equal(sibling.exitCode, 0)
    } finally { await supervisor.stop(); await rm(root, { recursive: true, force: true }) }
})

test('UI death while the engine is starting rejects startup and cleans every attempted engine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-startup-race-'))
    const children = []
    let ui
    const supervisor = new RuntimeSupervisor({
        root, identity: identity(), bundle: { nodePath: process.execPath, uiRoot: root, engineEntry: 'fixture', buildId: 'example-build' },
        launch: (command, args, options) => {
            const engine = args.includes('desktop-run')
            if (engine) ui.kill('SIGKILL')
            const child = spawn(command, [fixture], { ...options, env: { ...options.env, FIXTURE_KIND: engine ? 'engine' : 'ui' } })
            children.push(child)
            if (!engine) ui = child
            return child
        }, startupTimeout: 3000, stopTimeout: 1000,
    })
    const states = []
    supervisor.on('status', status => states.push(status.state))
    try {
        await assert.rejects(supervisor.start(), /could not start/)
        assert.equal(supervisor.status.state, 'error')
        assert(!states.includes('ready'))
        assert.equal(supervisor.children.size, 0)
        assert(children.every(child => child.exitCode !== null || child.signalCode !== null))
    } finally { await supervisor.stop(); await rm(root, { recursive: true, force: true }) }
})
