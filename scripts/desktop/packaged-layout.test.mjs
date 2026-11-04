import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopMain = fileURLToPath(new URL('../../apps/desktop/src/main/', import.meta.url))
const { loadBundle } = await import(join(desktopMain, 'runtime.mjs'))
const { RuntimeSupervisor } = await import(join(desktopMain, 'supervisor.mjs'))

async function fakeResources() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-packaged-layout-'))
    await mkdir(join(root, 'runtime', 'node', 'bin'), { recursive: true })
    await mkdir(join(root, 'runtime', 'ui'), { recursive: true })
    await mkdir(join(root, 'runtime', 'engine', 'dist', 'cli'), { recursive: true })
    await mkdir(join(root, 'main'), { recursive: true })
    await writeFile(join(root, 'runtime', 'node', 'bin', 'node'), 'fake')
    await writeFile(join(root, 'runtime', 'engine', 'dist', 'cli', 'bin.js'), 'fake')
    await writeFile(join(root, 'main', 'ui-host.mjs'), 'fake')
    await writeFile(join(root, 'runtime', 'rerun-codex'), 'fake')
    await writeFile(join(root, 'runtime', 'rerun-rename-entry'), 'fake')
    await writeFile(join(root, 'runtime-manifest.json'), JSON.stringify({
        protocolVersion: 1,
        buildId: 'layout-test-desktop-0.1.0',
        sourceCommit: 'f'.repeat(40),
        nodePath: 'runtime/node/bin/node',
        uiRoot: 'runtime/ui',
        engineEntry: 'runtime/engine/dist/cli/bin.js',
        uiHost: 'main/ui-host.mjs',
        codexPath: 'runtime/rerun-codex',
        renameHelperPath: 'runtime/rerun-rename-entry',
    }))
    return root
}

class FakeChild extends EventEmitter {
    constructor() {
        super()
        this.stdout = { resume() {} }
        this.stderr = { resume() {} }
        this.exitCode = null
        this.signalCode = null
        this.connected = true
    }
    send(message, callback) {
        this.connected = false
        this.exitCode = 0
        callback?.()
        queueMicrotask(() => this.emit('exit', 0))
    }
    kill() {
        this.exitCode = 0
        this.signalCode = 'SIGTERM'
        queueMicrotask(() => this.emit('exit', 0))
        return true
    }
}

test('loadBundle resolves the packaged UI host from the manifest inside resources', async () => {
    const root = await fakeResources()
    try {
        const bundle = await loadBundle(root)
        assert.equal(typeof bundle.uiHost, 'string')
        assert.equal(bundle.uiHost, await realpath(resolve(root, 'main', 'ui-host.mjs')))
        assert(existsSync(bundle.uiHost))
        assert(!bundle.uiHost.includes('.asar'))
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('loadBundle rejects a UI host path that escapes resources', async () => {
    const root = await fakeResources()
    try {
        const manifest = JSON.parse(await readFile(join(root, 'runtime-manifest.json'), 'utf8'))
        manifest.uiHost = '../outside/ui-host.mjs'
        await writeFile(join(root, 'runtime-manifest.json'), JSON.stringify(manifest))
        await assert.rejects(loadBundle(root), /escapes Resources|Invalid bundled runtime path/)
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('the supervisor launches the UI child through the real resource path, never an app.asar path', async () => {
    const resources = await fakeResources()
    const dataRoot = await mkdtemp(join(tmpdir(), 'rerun-packaged-data-'))
    try {
        const bundle = await loadBundle(resources)
        const spawned = []
        const launch = (command, args, options) => {
            spawned.push({ command, args, env: options.env })
            const child = new FakeChild()
            const runtimeFile = options.env?.RERUN_DESKTOP_RUNTIME_FILE
            queueMicrotask(async () => {
                try {
                    const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'))
                    child.emit('message', { type: 'ready', protocolVersion: 1, launchNonce: runtime.launchNonce, buildId: runtime.buildId })
                } catch {}
            })
            return child
        }
        const fetcher = async (url, options) => {
            const runtimeFile = join(dataRoot, 'runtime.json')
            const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'))
            return { ok: true, json: async () => ({ ...runtime, status: 'ready' }) }
        }
        let port = 55000
        const identity = { version: 1, installId: 'install-layout-test', engineApiKey: 'a'.repeat(64), encryptionKey: 'b'.repeat(64) }
        const supervisor = new RuntimeSupervisor({ bundle, root: dataRoot, identity, launch, fetcher, port: async () => ++port })
        const runtime = await supervisor.start()
        assert.equal(runtime.app.origin, 'http://127.0.0.1:55001')

        assert.equal(spawned.length, 2)
        const uiSpawn = spawned[0]
        assert.equal(uiSpawn.args[0], bundle.uiHost)
        assert(!uiSpawn.args[0].includes('app.asar'))
        assert(existsSync(uiSpawn.args[0]))
        assert.equal(uiSpawn.command, bundle.nodePath)
        assert.equal(uiSpawn.env.RERUN_DESKTOP_RENAME_HELPER, bundle.renameHelperPath)
        assert.equal(spawned[1].args[0], bundle.engineEntry)

        await supervisor.stop()
        assert.equal(supervisor.children.size, 0)
        assert(!existsSync(join(dataRoot, 'runtime.json')))
    } finally {
        await rm(resources, { recursive: true, force: true })
        await rm(dataRoot, { recursive: true, force: true })
    }
})
