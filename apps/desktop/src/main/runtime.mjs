import { randomBytes, randomUUID, createHmac } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, chmod, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { ensureOwnedWorkspaceDirectory, readJSON, pathExists, validWorkspaceId } from './workspaces/paths.mjs'

export const PROTOCOL_VERSION = 1

export function inside(root, name) {
    if (typeof name !== 'string' || isAbsolute(name)) throw new Error('Invalid bundled runtime path')
    const path = resolve(root, name)
    const rel = relative(root, path)
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Bundled runtime path escapes Resources')
    return path
}

export async function loadBundle(resources) {
    const manifest = JSON.parse(await readFile(resolve(resources, 'runtime-manifest.json'), 'utf8'))
    if (manifest.protocolVersion !== PROTOCOL_VERSION || typeof manifest.buildId !== 'string' || !manifest.buildId) throw new Error('Unsupported desktop runtime manifest')
    if (Object.hasOwn(manifest, 'arch') && manifest.arch !== process.arch) throw new Error('Bundled runtime architecture does not match the Mac app')
    const root = await realpath(resources)
    const paths = {}
    const baseFields = ['nodePath', 'uiRoot', 'engineEntry', 'uiHost', 'codexPath', 'claudePath', 'claudeSandboxPath', 'renameHelperPath', 'pdfHelperPath', 'pdfTextHelperPath']
    const runners = ['grokBuildPath', 'kimiCodePath'].filter(field => Object.hasOwn(manifest, field))
    const runnerFields = runners.length ? [...runners, 'subscriptionSandboxPath'] : []
    if (Object.hasOwn(manifest, 'subscriptionLoginSandboxPath')) {
        if (!runners.length) throw new Error('Invalid bundled subscription sign-in manifest')
        runnerFields.push('subscriptionLoginSandboxPath')
    }
    if (Object.hasOwn(manifest, 'subscriptionSandboxPath') !== (runners.length > 0)) {
        throw new Error('Invalid bundled subscription runner manifest')
    }
    for (const field of [...baseFields, ...runnerFields]) {
        const path = inside(root, manifest[field])
        const actual = await realpath(path)
        const rel = relative(root, actual)
        if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Bundled runtime symlink escapes Resources')
        if (runnerFields.includes(field) && actual !== path) throw new Error('Bundled subscription runner cannot be a symlink')
        paths[field] = actual
    }
    return { ...paths, buildId: manifest.buildId }
}

export async function atomicPrivateJSON(path, value) {
    const temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
    await chmod(path, 0o600)
}

export async function loadIdentity(root, cipher) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const path = resolve(root, 'identity.encrypted')
    let bytes
    try { bytes = await readFile(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (bytes) {
        const identity = JSON.parse(cipher.decrypt(bytes))
        if (identity.version !== 1 || typeof identity.installId !== 'string' || !/^[a-f0-9]{64}$/.test(identity.engineApiKey) || !/^[a-f0-9]{64}$/.test(identity.encryptionKey)) throw new Error('Invalid encrypted desktop identity')
        return identity
    }
    const identity = { version: 1, installId: randomUUID(), engineApiKey: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') }
    await writeFile(path, cipher.encrypt(JSON.stringify(identity)), { flag: 'wx', mode: 0o600 })
    return identity
}

export class DesktopSecureStorageError extends Error {
    constructor(cause) {
        super('Desktop secure storage is unavailable', { cause })
    }
}

export async function loadIdentityFromSafeStorage(root, safeStorage) {
    function useSecureStorage(operation) {
        try { return operation() }
        catch (cause) { throw new DesktopSecureStorageError(cause) }
    }
    if (!useSecureStorage(() => safeStorage.isEncryptionAvailable())) throw new DesktopSecureStorageError()
    return loadIdentity(root, {
        encrypt: value => useSecureStorage(() => safeStorage.encryptString(value)),
        decrypt: value => useSecureStorage(() => safeStorage.decryptString(value)),
    })
}

export function workspaceIdentity(identity, workspaceId) {
    if (!validWorkspaceId(workspaceId)) throw new Error('Invalid workspace identity')
    if (workspaceId === 1) return identity
    const derive = domain => createHmac('sha256', identity.encryptionKey).update(`${domain}:${workspaceId}`).digest('hex')
    return { ...identity, encryptionKey: derive('rerun-workspace-encryption-v1'), engineApiKey: derive('rerun-workspace-api-v1') }
}
export async function bindWorkspace(root, identity, workspaceId = 1) {
    let engine
    try { ({ engine } = await ensureOwnedWorkspaceDirectory(root, identity.installId, workspaceId)) }
    catch { throw new Error('This engine data folder belongs to another workspace or cannot be verified') }
    const file = resolve(engine, 'desktop-owner.json')
    const existing = await pathExists(file) ? await readJSON(file) : null
    if (existing && (existing.installId !== identity.installId || existing.workspaceId !== workspaceId)) throw new Error('This engine data folder belongs to another workspace')
    if (!existing) await writeFile(file, JSON.stringify({ installId: identity.installId, workspaceId }), { flag: 'wx', mode: 0o600 })
    return engine
}

export function childEnvironment(parent = process.env) {
    const clean = {}
    for (const name of ['HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
        if (parent[name]) clean[name] = parent[name]
    }
    return { ...clean, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' }
}

export function publicStatus(state, message = '') {
    return { state, message }
}
