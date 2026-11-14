import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, access, readFile, lstat, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { RuntimeSupervisor } from '../src/main/supervisor.mjs'

test('native draft drain forwards only a bounded save to its owned UI and rejects a stale lifetime', async () => {
    const calls = []
    const supervisor = new RuntimeSupervisor({ fetcher: async (...args) => {
        calls.push(args)
        return Response.json({ draft: { revision: 1, text: 'pending' } })
    } })
    const runtime = { app: { origin: 'http://127.0.0.1:1' }, engine: { apiKey: 'fixture-key' }, launchNonce: randomUUID() }
    supervisor.runtime = runtime
    const lifetime = new AbortController()
    const body = JSON.stringify({ text: 'pending' })
    await assert.rejects(supervisor.saveDrainingDraft('../outside', body, lifetime.signal), /Invalid pending draft/)
    await assert.rejects(supervisor.saveDrainingDraft('agent-1', 'x'.repeat(256 * 1024 + 1), lifetime.signal), /Invalid pending draft/)
    assert.equal(calls.length, 0)
    const saved = await supervisor.saveDrainingDraft('agent-1', body, lifetime.signal)
    assert.equal(saved.status, 200)
    assert.deepEqual(JSON.parse(saved.body), { draft: { revision: 1, text: 'pending' } })
    assert.deepEqual(calls[0], [runtime.app.origin + '/api/desktop/agents/agent-1/draft', {
        method: 'PUT', redirect: 'error', signal: lifetime.signal,
        headers: { Authorization: 'Bearer fixture-key', 'X-Rerun-Launch-Nonce': runtime.launchNonce, 'Content-Type': 'application/json' },
        body,
    }])
    lifetime.abort()
    await assert.rejects(supervisor.saveDrainingDraft('agent-1', body, lifetime.signal), { name: 'AbortError' })
    assert.equal(calls.length, 1)
    supervisor.fetcher = async () => {
        supervisor.runtime = { ...runtime, launchNonce: randomUUID() }
        return Response.json({ draft: { revision: 1, text: 'old workspace' } })
    }
    await assert.rejects(supervisor.saveDrainingDraft('agent-1', body, new AbortController().signal), /workspace changed/)
})

const fixture = fileURLToPath(new URL('./service-fixture.mjs', import.meta.url))
const identity = () => ({ installId: randomUUID(), engineApiKey: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') })

test('private shutdown evidence distinguishes a timed-out clean late engine from a rejected UI exit without exposing runtime secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-native-stop-evidence-'))
    const workspaceIdentity = identity()
    const supervisor = new RuntimeSupervisor({ root, identity: workspaceIdentity, bundle: { nodePath: '/private/never-journal-command' }, stopTimeout: 1,
        launch: (_command, args) => {
            const child = new EventEmitter()
            Object.assign(child, { exitCode: null, signalCode: null, connected: true, privateError: 'never-journal-error',
                send(_message, callback) {
                    if (args[0] === 'ui') { this.exitCode = 143; this.emit('exit', 143, null) }
                    callback?.()
                }, kill() { assert.fail('A journal must not force a process verdict') },
            })
            return child
        },
    })
    const runtime = { launchNonce: randomUUID(), workspaceId: 7, installRoot: await realpath(root), app: { origin: 'http://127.0.0.1:3000', sessionToken: 'never-journal-session' }, engine: { apiKey: 'never-journal-engine-key' } }
    supervisor.runtime = runtime; supervisor.toolsDrainedRuntime = runtime
    const ui = supervisor.spawnOwned(['ui', 'never-journal-argument'], { PRIVATE: 'never-journal-environment' }, undefined, 'ui')
    const engine = supervisor.spawnOwned(['engine'], {}, runtime.launchNonce, 'engine')
    supervisor.publish('ready')
    try {
        await assert.rejects(supervisor.stop(), /cleanup was not confirmed/)
        const file = join(root, 'shutdown-diagnostics.json')
        assert.equal((await lstat(file)).mode & 0o777, 0o600)
        const failed = JSON.parse(await readFile(file, 'utf8'))
        assert(failed.events.some(row => row.event === 'child-stop-verdict' && row.role === 'engine' && row.timeout && row.confirmed === false && row.sameRuntimeToolsAck && !row.stoppedAck && row.exitCode === null))
        assert.equal(failed.events.at(-1).event, 'stop-failed')
        assert(supervisor.children.has(engine)); assert(supervisor.children.has(ui))

        engine.emit('message', { type: 'stopped', launchNonce: 'foreign-launch' })
        assert.equal(engine.stoppedAcknowledged, undefined)
        engine.emit('message', { type: 'stopped', launchNonce: runtime.launchNonce })
        engine.exitCode = 0; engine.emit('exit', 0, null)
        await supervisor.shutdownDiagnosticWrites
        const late = JSON.parse(await readFile(file, 'utf8'))
        assert(late.events.some(row => row.event === 'child-exit' && row.role === 'engine' && row.exitCode === 0 && row.stoppedAck && !row.unconfirmedEngineExit))
        await supervisor.stop()
        const stopped = JSON.parse(await readFile(file, 'utf8'))
        assert(stopped.events.some(row => row.event === 'child-stop-verdict' && row.role === 'ui' && row.exitCode === 143 && row.signalCode === null && row.confirmed))
        assert.equal(stopped.events.at(-1).event, 'stop-succeeded')
        const keys = ['event', 'launchNonce', 'workspaceId', 'role', 'exitCode', 'signalCode', 'shutdownFailed', 'stopRequested', 'stoppedAck', 'sameRuntimeToolsAck', 'unconfirmedEngineExit', 'timeout', 'confirmed', 'force'].sort()
        for (const row of stopped.events) { assert.deepEqual(Object.keys(row).sort(), keys); assert.equal(row.launchNonce, runtime.launchNonce); assert.equal(row.workspaceId, 7) }
        const text = JSON.stringify(stopped)
        for (const secret of ['never-journal', root, workspaceIdentity.encryptionKey, workspaceIdentity.engineApiKey]) assert(!text.includes(secret))
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('shutdown evidence records a rejected raw UI signal, caps its history, and never follows a substituted journal symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-native-stop-ui-evidence-'))
    const supervisor = new RuntimeSupervisor({ root, bundle: {}, identity: identity() })
    supervisor.runtime = { launchNonce: randomUUID(), workspaceId: 1, installRoot: await realpath(root) }
    supervisor.toolsDrainedRuntime = supervisor.runtime
    const child = new EventEmitter()
    Object.assign(child, { desktopRole: 'ui', exitCode: null, signalCode: null, connected: true,
        send() { this.signalCode = 'SIGTERM'; this.emit('exit', null, 'SIGTERM') },
    })
    supervisor.children.add(child)
    try {
        assert.equal(await supervisor.stopChildren(false), false)
        await supervisor.shutdownDiagnosticWrites
        const file = join(root, 'shutdown-diagnostics.json')
        const saved = JSON.parse(await readFile(file, 'utf8'))
        assert(saved.events.some(row => row.event === 'child-stop-verdict' && row.role === 'ui' && row.signalCode === 'SIGTERM' && !row.timeout && row.confirmed === false && row.sameRuntimeToolsAck))
        for (let index = 0; index < 80; index++) supervisor.shutdownDiagnostic('stop-requested')
        await supervisor.shutdownDiagnosticWrites
        assert.equal(JSON.parse(await readFile(file, 'utf8')).events.length, 64)
        await rm(file)
        const outside = join(root, 'protected-content')
        await writeFile(outside, 'unchanged', { mode: 0o600 })
        await symlink(outside, file)
        supervisor.shutdownDiagnostic('stop-failed')
        await supervisor.shutdownDiagnosticWrites
        assert.equal(await readFile(outside, 'utf8'), 'unchanged')
        assert((await lstat(file)).isSymbolicLink())
    } finally { await rm(root, { recursive: true, force: true }) }
})

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
    test(`late engine ${name} after a stop timeout retains its verdict while reusing the exact UI drain ACK`, async () => {
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
            // failed; the cached UI acknowledgement proves nothing about this engine.
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
            assert.equal(drainAcknowledgements, 1)
        } finally { await rm(root, { recursive: true, force: true }) }
    })
}

for (const appStoreBuild of [false, true]) test(`real supervised processes require authenticated readiness and quit cleanly (${appStoreBuild ? 'App Store' : 'direct build'})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-supervisor-'))
    const children = []
    const workspaceIdentity = identity()
    const supervisor = new RuntimeSupervisor({
        root, identity: workspaceIdentity, appStoreBuild,
        bundle: { nodePath: process.execPath, uiRoot: root, engineEntry: 'fixture', buildId: 'example-build',
            codexPath: '/fixture/codex', claudePath: '/fixture/claude', claudeSandboxPath: '/fixture/claude.sb',
            grokBuildPath: '/fixture/grok', kimiCodePath: '/fixture/kimi',
            subscriptionSandboxPath: '/fixture/subscription.sb', subscriptionLoginSandboxPath: '/fixture/login.sb',
            renameHelperPath: '/fixture/rename' },
        launch: (command, args, options) => {
            assert.equal(options.env.RERUN_DESKTOP_SECRET_KEY, workspaceIdentity.encryptionKey)
            const engine = args.includes('desktop-run')
            assert.equal(options.env.RERUN_DESKTOP_APP_STORE, appStoreBuild ? '1' : undefined)
            assert.equal(options.env.RERUN_DESKTOP_RENAME_HELPER, '/fixture/rename')
            for (const [key, file] of [
                ['CODEX_RUNNER', 'codex'], ['CLAUDE_RUNNER', 'claude'], ['CLAUDE_SANDBOX', 'claude.sb'],
                ['GROK_BUILD_RUNNER', 'grok'], ['KIMI_CODE_RUNNER', 'kimi'],
                ['SUBSCRIPTION_SANDBOX', 'subscription.sb'], ['SUBSCRIPTION_LOGIN_SANDBOX', 'login.sb'],
            ]) assert.equal(options.env['RERUN_DESKTOP_' + key], engine && !appStoreBuild ? '/fixture/' + file : undefined)
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
