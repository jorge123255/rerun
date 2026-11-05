import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { RuntimeSupervisor } from '../src/main/supervisor.mjs'

const fixture = fileURLToPath(new URL('./service-fixture.mjs', import.meta.url))
const identity = () => ({ installId: randomUUID(), engineApiKey: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') })

test('only a requested UI graceful exit accepts 143 after this launch has drained tools', async () => {
    for (const [role, code, signal, drained, accepted] of [
        ['ui', 143, null, true, true],
        ['ui', 143, null, false, false],
        ['engine', 143, null, true, false],
        ['ui', 143, 'SIGTERM', true, false],
        ['ui', 1, null, true, false],
    ]) {
        const supervisor = new RuntimeSupervisor({ bundle: {}, root: '', identity: identity() })
        supervisor.runtime = { launchNonce: randomUUID() }
        supervisor.toolsDrainedRuntime = drained ? supervisor.runtime : { launchNonce: 'old-launch' }
        const child = new EventEmitter()
        Object.assign(child, { desktopRole: role, exitCode: null, signalCode: null, connected: true,
            send() { this.exitCode = code; this.signalCode = signal; this.emit('exit', code, signal) } })
        supervisor.children.add(child)
        assert.equal(await supervisor.stopChildren(false), accepted, `${role}/${code}/${signal}/${drained}`)
    }
})

test('a failed local-process drain keeps authority alive and reports an error until retry succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-drain-'))
    let acknowledged = false
    const supervisor = new RuntimeSupervisor({ root, identity: identity(), bundle: {}, fetcher: async () => Response.json({ stopped: acknowledged }) })
    supervisor.runtime = { app: { origin: 'http://127.0.0.1:3000' }, engine: { apiKey: 'fixture' } }
    const child = new EventEmitter()
    Object.assign(child, { exitCode: null, signalCode: null, connected: true, send() { this.exitCode = 0; this.emit('exit', 0, null) } })
    supervisor.children.add(child)
    try {
        await assert.rejects(supervisor.stop(), /cleanup was not confirmed/)
        assert.equal(supervisor.status.state, 'error')
        assert.equal(supervisor.children.size, 1)
        assert.equal(child.exitCode, null)
        acknowledged = true
        await supervisor.stop()
        assert.equal(supervisor.status.state, 'stopped')
        assert.equal(supervisor.children.size, 0)
    } finally { await rm(root, { recursive: true, force: true }) }
})

for (const { name, code, signal, accepted } of [
    { name: 'nonzero exit', code: 1, signal: null, accepted: false },
    { name: 'raw signal', code: null, signal: 'SIGKILL', accepted: false },
    { name: 'confirmed clean exit', code: 0, signal: null, accepted: true },
]) {
    test(`late engine ${name} after a stop timeout retains its verdict across a fresh UI drain ACK`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'rerun-late-engine-exit-'))
        const runtime = { launchNonce: randomUUID(), app: { origin: 'http://127.0.0.1:3000' }, engine: { apiKey: 'fixture' } }
        let drainAcknowledgements = 0, uiStops = 0, engineStops = 0
        const supervisor = new RuntimeSupervisor({
            root, identity: identity(), bundle: { nodePath: 'unused-fake-launch' }, stopTimeout: 1,
            fetcher: async () => { drainAcknowledgements++; return Response.json({ stopped: true }) },
            launch: (_command, args) => {
                const child = new EventEmitter()
                Object.assign(child, { exitCode: null, signalCode: null, connected: true,
                    send(message, callback) {
                        assert.equal(message.type, 'stop')
                        if (args[0] === 'ui') {
                            uiStops++
                            this.exitCode = 143
                            this.emit('exit', 143, null)
                        } else engineStops++ // Deliberately outlive the first stop timeout.
                        callback?.()
                    },
                    kill() { assert.fail('Ordinary Quit must not force-kill an unconfirmed service') },
                })
                return child
            },
        })
        supervisor.runtime = runtime
        const ui = supervisor.spawnOwned(['ui'], {}, undefined, 'ui')
        const engine = supervisor.spawnOwned(['engine'], {}, runtime.launchNonce, 'engine')
        supervisor.publish('ready')
        try {
            await assert.rejects(supervisor.stop(), /cleanup was not confirmed/)
            assert.equal(supervisor.status.state, 'error')
            assert.equal(drainAcknowledgements, 1)
            assert.equal(engineStops, 1)
            assert.equal(uiStops, 0)
            assert(supervisor.children.has(engine))

            // Exercise spawnOwned's actual exit listener after stop() has already
            // failed; a second UI acknowledgement proves nothing about this engine.
            if (accepted) engine.emit('message', { type: 'stopped', launchNonce: runtime.launchNonce })
            engine.exitCode = code
            engine.signalCode = signal
            engine.emit('exit', code, signal)

            if (accepted) {
                await supervisor.stop()
                assert.equal(supervisor.status.state, 'stopped')
                assert.equal(supervisor.children.size, 0)
                assert.equal(uiStops, 1)
                assert.equal(ui.exitCode, 143)
            } else {
                await assert.rejects(supervisor.stop(), /cleanup was not confirmed/)
                assert.equal(supervisor.status.state, 'error')
                assert.equal(supervisor.runtime, runtime)
                assert.equal(uiStops, 0)
                assert.equal(ui.exitCode, null)
                assert(supervisor.children.has(ui))
            }
            assert.equal(drainAcknowledgements, 2)
        } finally { await rm(root, { recursive: true, force: true }) }
    })
}

test('real supervised processes require authenticated nonce readiness and Quit removes owned children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-supervisor-'))
    const children = []
    const workspaceIdentity = identity()
    const supervisor = new RuntimeSupervisor({
        root, identity: workspaceIdentity, bundle: { nodePath: process.execPath, uiRoot: root, engineEntry: 'fixture', buildId: 'example-build' },
        launch: (command, args, options) => {
            assert.equal(options.env.RERUN_DESKTOP_SECRET_KEY, workspaceIdentity.encryptionKey)
            const engine = args.includes('desktop-run')
            const child = spawn(command, [fixture], { ...options, env: { ...options.env, FIXTURE_KIND: engine ? 'engine' : 'ui', FIXTURE_STOP_EXIT_CODE: engine ? '0' : '143' } })
            children.push(child)
            return child
        }, startupTimeout: 3000, stopTimeout: 1000,
    })
    try {
        const runtime = await supervisor.start()
        assert.equal(supervisor.status.state, 'ready')
        assert.equal(children.length, 2)
        assert(!(await readFile(join(root, 'runtime.json'), 'utf8')).includes(workspaceIdentity.encryptionKey))
        assert.equal((await fetch(`${runtime.engine.origin}/health`)).status, 401)
        assert.equal((await fetch(`${runtime.app.origin}/api/desktop/health`)).status, 401)
        await supervisor.stop()
        assert.deepEqual(children.map(child => child.exitCode), [143, 0])
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
        // The dead UI cannot attest to detached local-program cleanup. Keep the
        // explicit error rather than treating parent service exit as proof.
        await assert.rejects(supervisor.stop())
    } finally { await supervisor.stop().catch(() => {}); await rm(root, { recursive: true, force: true }) }
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
