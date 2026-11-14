import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopMain = fileURLToPath(new URL('../../apps/desktop/src/main/', import.meta.url))
const { loadBundle } = await import(join(desktopMain, 'runtime.mjs'))
const { RuntimeSupervisor } = await import(join(desktopMain, 'supervisor.mjs'))

async function fakeResources(includeSubscriptionRunner = false) {
    const root = await mkdtemp(join(tmpdir(), 'rerun-packaged-layout-'))
    await mkdir(join(root, 'runtime', 'node', 'bin'), { recursive: true })
    await mkdir(join(root, 'runtime', 'ui'), { recursive: true })
    await mkdir(join(root, 'runtime', 'engine', 'dist', 'cli'), { recursive: true })
    await mkdir(join(root, 'main'), { recursive: true })
    await writeFile(join(root, 'runtime', 'node', 'bin', 'node'), 'fake')
    await writeFile(join(root, 'runtime', 'engine', 'dist', 'cli', 'bin.js'), 'fake')
    await writeFile(join(root, 'main', 'ui-host.mjs'), 'fake')
    await writeFile(join(root, 'runtime', 'rerun-codex'), 'fake')
    await writeFile(join(root, 'runtime', 'rerun-claude'), 'fake')
    await writeFile(join(root, 'runtime', 'rerun-claude.sb'), 'fake')
    await writeFile(join(root, 'runtime', 'rerun-rename-entry'), 'fake')
    await writeFile(join(root, 'runtime', 'rerun-render-pdf'), 'fake')
    await writeFile(join(root, 'runtime', 'rerun-pdf-text'), 'fake')
    if (includeSubscriptionRunner) {
        await writeFile(join(root, 'runtime', 'grok-build'), 'fake')
        await writeFile(join(root, 'runtime', 'rerun-subscriptions.sb'), 'fake')
    }
    await writeFile(join(root, 'runtime-manifest.json'), JSON.stringify({
        protocolVersion: 1,
        buildId: 'layout-test-desktop-0.1.0',
        sourceCommit: 'f'.repeat(40),
        nodePath: 'runtime/node/bin/node',
        uiRoot: 'runtime/ui',
        engineEntry: 'runtime/engine/dist/cli/bin.js',
        uiHost: 'main/ui-host.mjs',
        codexPath: 'runtime/rerun-codex',
        claudePath: 'runtime/rerun-claude',
        claudeSandboxPath: 'runtime/rerun-claude.sb',
        renameHelperPath: 'runtime/rerun-rename-entry',
        pdfHelperPath: 'runtime/rerun-render-pdf',
        pdfTextHelperPath: 'runtime/rerun-pdf-text',
        ...(includeSubscriptionRunner ? {
            grokBuildPath: 'runtime/grok-build', subscriptionSandboxPath: 'runtime/rerun-subscriptions.sb',
        } : {}),
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
        assert.equal(bundle.claudePath, await realpath(resolve(root, 'runtime', 'rerun-claude')))
        assert.equal(bundle.claudeSandboxPath, await realpath(resolve(root, 'runtime', 'rerun-claude.sb')))
        assert.equal(bundle.pdfHelperPath, await realpath(resolve(root, 'runtime', 'rerun-render-pdf')))
        assert.equal(bundle.subscriptionSandboxPath, undefined)
        assert.equal(bundle.pdfTextHelperPath, await realpath(resolve(root, 'runtime', 'rerun-pdf-text')))
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

test('loadBundle rejects a runtime from the other Mac architecture before launching services', async () => {
    const root = await fakeResources()
    try {
        const file = join(root, 'runtime-manifest.json')
        const manifest = JSON.parse(await readFile(file, 'utf8'))
        await writeFile(file, JSON.stringify({ ...manifest, arch: process.arch === 'arm64' ? 'x64' : 'arm64' }))
        await assert.rejects(loadBundle(root), /architecture does not match/)
        await writeFile(file, JSON.stringify({ ...manifest, arch: process.arch }))
        assert.equal((await loadBundle(root)).buildId, manifest.buildId)
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('the supervisor launches the UI child through the real resource path, never an app.asar path', async () => {
    const resources = await fakeResources(true)
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
            if (url.endsWith('/api/desktop/internal/mcp') && options?.method === 'POST') {
                assert.deepEqual(JSON.parse(options.body), { action: 'shutdown' })
                return { ok: true, json: async () => ({ stopped: true }) }
            }
            const runtimeFile = join(dataRoot, 'runtime.json')
            const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'))
            return { ok: true, json: async () => ({ ...runtime, status: 'ready' }) }
        }
        let port = 55000
        const identity = { version: 1, installId: '11111111-1111-4111-8111-111111111111', engineApiKey: 'a'.repeat(64), encryptionKey: 'b'.repeat(64) }
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
        assert.equal(uiSpawn.env.RERUN_DESKTOP_PDF_HELPER, bundle.pdfHelperPath)
        assert.equal(uiSpawn.env.RERUN_DESKTOP_PDF_TEXT_HELPER, bundle.pdfTextHelperPath)
        assert.equal(spawned[1].env.RERUN_DESKTOP_PDF_HELPER, undefined)
        assert.equal(spawned[1].env.RERUN_DESKTOP_PDF_TEXT_HELPER, undefined)
        assert.equal(spawned[1].args[0], bundle.engineEntry)
        assert.equal(uiSpawn.env.RERUN_DESKTOP_GROK_BUILD_RUNNER, undefined)
        assert.equal(spawned[1].env.RERUN_DESKTOP_GROK_BUILD_RUNNER, await realpath(join(resources, 'runtime/grok-build')))
        assert.equal(spawned[1].env.RERUN_DESKTOP_KIMI_CODE_RUNNER, undefined)
        assert.equal(spawned[1].env.RERUN_DESKTOP_SUBSCRIPTION_SANDBOX, await realpath(join(resources, 'runtime/rerun-subscriptions.sb')))

        await supervisor.stop()
        assert.equal(supervisor.children.size, 0)
        assert(!existsSync(join(dataRoot, 'runtime.json')))
    } finally {
        await rm(resources, { recursive: true, force: true })
        await rm(dataRoot, { recursive: true, force: true })
    }
})

test('loadBundle requires the offline policy with optional runners and rejects runner symlinks', async () => {
    const root = await fakeResources(true)
    try {
        const file = join(root, 'runtime-manifest.json')
        const manifest = JSON.parse(await readFile(file, 'utf8'))
        const { subscriptionSandboxPath, ...withoutPolicy } = manifest
        await writeFile(file, JSON.stringify(withoutPolicy))
        await assert.rejects(loadBundle(root), /Invalid bundled subscription runner manifest/)
        await writeFile(file, JSON.stringify({ ...withoutPolicy, subscriptionSandboxPath }))
        await rm(join(root, 'runtime/grok-build'))
        await symlink(join(root, 'runtime/rerun-claude'), join(root, 'runtime/grok-build'))
        await assert.rejects(loadBundle(root), /cannot be a symlink/)
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('loadBundle refuses a missing, traversing, or externally linked PDF helper', async () => {
    const root = await fakeResources()
    try {
        const file = join(root, 'runtime-manifest.json')
        const manifest = JSON.parse(await readFile(file, 'utf8'))
        const missing = { ...manifest }; delete missing.pdfHelperPath
        await writeFile(file, JSON.stringify(missing))
        await assert.rejects(loadBundle(root), /Invalid bundled runtime path/)
        await writeFile(file, JSON.stringify({ ...manifest, pdfHelperPath: '../outside-helper' }))
        await assert.rejects(loadBundle(root), /escapes Resources/)
        await rm(join(root, 'runtime', 'rerun-render-pdf'))
        await symlink(process.execPath, join(root, 'runtime', 'rerun-render-pdf'))
        await writeFile(file, JSON.stringify(manifest))
        await assert.rejects(loadBundle(root), /symlink escapes Resources/)
    } finally { await rm(root, { recursive: true, force: true }) }
})
