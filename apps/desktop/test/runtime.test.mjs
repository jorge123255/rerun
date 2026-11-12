import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childEnvironment, loadBundle, loadIdentity, loadIdentityFromSafeStorage, DesktopSecureStorageError, bindWorkspace, atomicPrivateJSON } from '../src/main/runtime.mjs'

test('profile identity persists, private files stay private, and another install cannot adopt its engine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-identity-'))
    try {
        const cipher = { encrypt: value => Buffer.from(value), decrypt: value => value.toString() }
        const first = await loadIdentity(root, cipher)
        assert.deepEqual(await loadIdentity(root, cipher), first)
        assert.equal((await stat(join(root, 'identity.encrypted'))).mode & 0o777, 0o600)
        const engine = await bindWorkspace(root, first)
        await writeFile(join(engine, 'prior-workspace.txt'), 'synthetic prior data')
        await assert.rejects(bindWorkspace(root, { ...first, installId: 'another-install' }), /another workspace/)
        assert.equal(await readFile(join(engine, 'prior-workspace.txt'), 'utf8'), 'synthetic prior data')
        await atomicPrivateJSON(join(root, 'runtime.json'), { example: true })
        assert.equal((await stat(join(root, 'runtime.json'))).mode & 0o777, 0o600)
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('safe storage refusal leaves existing identity bytes intact and creates no substitute', async t => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-identity-secure-storage-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const file = join(root, 'identity.encrypted')
    const refused = new Error('Permission refused by fixture')
    const safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: () => { throw refused },
        decryptString: () => { throw refused },
    }
    await assert.rejects(loadIdentityFromSafeStorage(root, { isEncryptionAvailable: () => false }), DesktopSecureStorageError)
    await assert.rejects(loadIdentityFromSafeStorage(root, safeStorage), { cause: refused })
    await assert.rejects(stat(file), { code: 'ENOENT' })

    const sealed = Buffer.from('synthetic existing ciphertext')
    await writeFile(file, sealed, { mode: 0o600 })
    await assert.rejects(loadIdentityFromSafeStorage(root, safeStorage), DesktopSecureStorageError)
    assert.deepEqual(await readFile(file), sealed)

    const existing = { version: 1, installId: 'synthetic-install', engineApiKey: 'a'.repeat(64), encryptionKey: 'b'.repeat(64) }
    const accessible = { ...safeStorage, decryptString: bytes => {
        assert.deepEqual(bytes, sealed)
        return JSON.stringify(existing)
    } }
    assert.deepEqual(await loadIdentityFromSafeStorage(root, accessible), existing)
    assert.deepEqual(await readFile(file), sealed)
    await assert.rejects(loadIdentityFromSafeStorage(root, { ...accessible, decryptString: () => '{}' }), /Invalid encrypted desktop identity/)
})

test('runtime children do not inherit provider keys, runtime injection flags, or user npm paths', () => {
    const env = childEnvironment({ HOME: '/example-home', OPENAI_API_KEY: 'example-secret', NODE_OPTIONS: '--require=untrusted.js', PATH: '/example-bin', RERUN_API_KEY: 'example-engine-key' })
    assert.equal(env.HOME, '/example-home')
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.RERUN_API_KEY, undefined)
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
})

test('bundled runtime rejects both path traversal and a symlink to an external executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-bundle-'))
    const outside = await mkdtemp(join(tmpdir(), 'rerun-outside-'))
    try {
        await mkdir(join(root, 'ui'))
        await writeFile(join(root, 'engine.js'), '')
        await symlink(process.execPath, join(root, 'node'))
        const manifest = { protocolVersion: 1, buildId: 'example-build', nodePath: 'node', uiRoot: 'ui', engineEntry: 'engine.js' }
        await writeFile(join(root, 'runtime-manifest.json'), JSON.stringify(manifest))
        await assert.rejects(loadBundle(root), /symlink escapes/)
        await writeFile(join(root, 'runtime-manifest.json'), JSON.stringify({ ...manifest, nodePath: '../outside-node' }))
        await assert.rejects(loadBundle(root), /escapes/)
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})
