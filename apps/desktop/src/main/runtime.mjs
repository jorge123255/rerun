import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, chmod, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

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
    const root = await realpath(resources)
    const paths = {}
    for (const field of ['nodePath', 'uiRoot', 'engineEntry', 'uiHost', 'codexPath', 'renameHelperPath']) {
        const path = inside(root, manifest[field])
        const actual = await realpath(path)
        const rel = relative(root, actual)
        if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Bundled runtime symlink escapes Resources')
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

export async function bindWorkspace(root, identity) {
    const engineRoot = resolve(root, 'workspaces', '1', 'engine')
    await mkdir(engineRoot, { recursive: true, mode: 0o700 })
    const file = resolve(engineRoot, 'desktop-owner.json')
    let existing
    try { existing = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (existing && (existing.installId !== identity.installId || existing.workspaceId !== 1)) throw new Error('This engine data folder belongs to another workspace')
    if (!existing) await writeFile(file, JSON.stringify({ installId: identity.installId, workspaceId: 1 }), { flag: 'wx', mode: 0o600 })
    return engineRoot
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
