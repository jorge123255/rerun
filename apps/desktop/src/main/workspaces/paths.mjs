import { mkdir, writeFile, rename, realpath, lstat, open, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve, sep, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const WORKSPACES_DIR = 'workspaces'
export const CATALOG_FILE = 'catalog.json'
export const SELECTION_FILE = 'selected.json'
export const SWITCHES_DIR = 'switches'
export const OWNER_FILE = 'owner.json'
export const LEGACY_WORKSPACE_ID = 1
export const CONTRACT_VERSION = 1
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function validWorkspaceId(value) { return Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000 }
export function workspacesRoot(dataRoot) { return resolve(dataRoot, WORKSPACES_DIR) }
export function catalogPath(dataRoot) { return resolve(workspacesRoot(dataRoot), CATALOG_FILE) }
export function selectionPath(dataRoot) { return resolve(workspacesRoot(dataRoot), SELECTION_FILE) }
export function switchesRoot(dataRoot) { return resolve(workspacesRoot(dataRoot), SWITCHES_DIR) }
export function switchReceiptPath(dataRoot, receiptId) {
    if (!UUID.test(receiptId)) throw new Error('Invalid switch receipt id')
    return resolve(switchesRoot(dataRoot), `${receiptId}.json`)
}
export function workspaceDirectory(dataRoot, workspaceId) {
    if (!validWorkspaceId(workspaceId)) throw new Error('Invalid workspace id')
    return resolve(workspacesRoot(dataRoot), String(workspaceId))
}
export function engineRootFor(dataRoot, workspaceId) { return resolve(workspaceDirectory(dataRoot, workspaceId), 'engine') }
export function ownerPath(dataRoot, workspaceId) { return resolve(workspaceDirectory(dataRoot, workspaceId), OWNER_FILE) }
export function appDatabasePath(dataRoot, workspaceId) {
    if (!validWorkspaceId(workspaceId)) throw new Error('Invalid workspace id')
    return workspaceId === LEGACY_WORKSPACE_ID ? resolve(dataRoot, 'app.db') : resolve(workspaceDirectory(dataRoot, workspaceId), 'app.db')
}
export function assertInsideWorkspaces(dataRoot, candidate) {
    const root = workspacesRoot(dataRoot), resolved = resolve(candidate), rel = relative(root, resolved)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Workspace path escapes the workspaces root')
    return resolved
}
export function persistenceError(message = 'Workspace state needs recovery.') {
    return Object.assign(new Error(message), { code: 'path_corrupt' })
}
async function statOrMissing(path) {
    try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function directory(path, create = false) {
    if (create) { try { await mkdir(path, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error } }
    const stat = await statOrMissing(path)
    if (!stat) return false
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw persistenceError('Workspace folder is not a regular directory.')
    return true
}
export async function inspectWorkspacesLayout(dataRoot) {
    const root = await realpath(dataRoot)
    if (!await directory(workspacesRoot(root))) return false
    if (!await directory(switchesRoot(root))) throw persistenceError('Workspace transition records are missing.')
    return true
}
export async function ensureWorkspacesLayout(dataRoot) {
    const root = await realpath(dataRoot)
    await directory(workspacesRoot(root), true)
    await directory(switchesRoot(root), true)
}
export async function atomicPrivateJSON(path, value) {
    if (!await directory(dirname(path))) throw persistenceError()
    const existing = await statOrMissing(path)
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw persistenceError()
    const temp = `${path}.${randomUUID()}.tmp`
    let file
    try {
        file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
        await file.sync(); await file.close(); file = null
        await rename(temp, path)
        const parent = await open(dirname(path), constants.O_RDONLY)
        try { await parent.sync() } finally { await parent.close() }
    } finally {
        await file?.close()
        await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
}
export async function readJSON(path) {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2_000_000) throw persistenceError()
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
        const actual = await file.stat()
        if (actual.ino !== stat.ino || actual.dev !== stat.dev || !actual.isFile()) throw persistenceError()
        return JSON.parse(await file.readFile('utf8'))
    } finally { await file.close() }
}
export async function pathExists(path) { return (await statOrMissing(path)) !== null }

export async function inspectWorkspacePath(dataRoot, installId, workspaceId) {
    const root = await realpath(dataRoot)
    const dir = workspaceDirectory(root, workspaceId), engine = engineRootFor(root, workspaceId)
    const result = (status, reason, extra = {}) => ({ status, dir, engine, reason, ...extra })
    try {
        if (!await directory(workspacesRoot(root))) return result('missing', 'Workspace folder is missing.')
        if (!await directory(dir)) return result('missing', 'Workspace folder is missing.')
        let owner
        try { owner = await readJSON(ownerPath(root, workspaceId)) }
        catch (error) {
            if (error.code !== 'ENOENT') return result('corrupt', 'Workspace ownership could not be read.')
            if (workspaceId !== LEGACY_WORKSPACE_ID) return result('foreign', 'This folder is not an owned workspace.')
            if (!await directory(engine)) return result('missing', 'Workspace engine folder is missing.')
            try { owner = await readJSON(resolve(engine, 'desktop-owner.json')) }
            catch (error) { return result(error.code === 'ENOENT' ? 'foreign' : 'corrupt', 'Workspace ownership could not be verified.') }
            if (owner.installId !== installId || owner.workspaceId !== workspaceId) return result('foreign', 'This folder belongs to another install.')
            return result('ready', null, { legacy: true })
        }
        if (owner.version !== CONTRACT_VERSION || owner.installId !== installId || owner.workspaceId !== workspaceId) return result('foreign', 'This folder belongs to another workspace.')
        if (!await directory(engine)) return result('missing', 'Workspace engine folder is missing.')
        const engineMarker = resolve(engine, 'desktop-owner.json')
        if (await pathExists(engineMarker)) {
            const engineOwner = await readJSON(engineMarker)
            if (engineOwner.installId !== installId || engineOwner.workspaceId !== workspaceId) return result('foreign', 'This engine belongs to another workspace.')
        }
        return result('ready', null)
    } catch (error) {
        if (error.code === 'path_corrupt') return result('corrupt', 'Workspace paths could not be verified.')
        throw error
    }
}

export async function ensureOwnedWorkspaceDirectory(dataRoot, installId, workspaceId, now = new Date().toISOString(), { createRequestId } = {}) {
    if (!UUID.test(installId)) throw persistenceError('Workspace install identity is invalid.')
    await ensureWorkspacesLayout(dataRoot)
    const root = await realpath(dataRoot), dir = workspaceDirectory(root, workspaceId), engine = engineRootFor(root, workspaceId)
    let created = false
    try { await mkdir(dir, { mode: 0o700 }); created = true } catch (error) { if (error.code !== 'EEXIST') throw error }
    if (created) {
        await writeFile(ownerPath(root, workspaceId), JSON.stringify({ version: CONTRACT_VERSION, installId, workspaceId, createdAt: now, ...(createRequestId ? { createRequestId } : {}) }), { flag: 'wx', mode: 0o600 })
        await directory(engine, true)
    } else {
        const inspected = await inspectWorkspacePath(root, installId, workspaceId)
        if (inspected.status !== 'ready') throw Object.assign(new Error(inspected.reason || 'Workspace path is not usable'), { code: inspected.status === 'foreign' ? 'path_foreign' : 'path_corrupt' })
        if (createRequestId) {
            const marker = await readJSON(ownerPath(root, workspaceId))
            if (marker.createRequestId !== createRequestId) throw Object.assign(new Error('Workspace directory already belongs to another creation.'), { code: 'path_foreign' })
        }
        if (inspected.legacy) await writeFile(ownerPath(root, workspaceId), JSON.stringify({ version: CONTRACT_VERSION, installId, workspaceId, createdAt: now }), { flag: 'wx', mode: 0o600 })
    }
    return { dir, engine }
}
export async function resolveRealDataRoot(dataRoot) { return realpath(dataRoot) }
