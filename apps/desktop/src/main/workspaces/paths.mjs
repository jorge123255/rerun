import { mkdir, readFile, writeFile, rename, chmod, realpath, access, lstat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export const WORKSPACES_DIR = 'workspaces'
export const CATALOG_FILE = 'catalog.json'
export const SELECTION_FILE = 'selected.json'
export const SWITCHES_DIR = 'switches'
export const OWNER_FILE = 'owner.json'
export const LEGACY_WORKSPACE_ID = 1
export const CONTRACT_VERSION = 1

export function workspacesRoot(dataRoot) {
    return resolve(dataRoot, WORKSPACES_DIR)
}

export function catalogPath(dataRoot) {
    return resolve(workspacesRoot(dataRoot), CATALOG_FILE)
}

export function selectionPath(dataRoot) {
    return resolve(workspacesRoot(dataRoot), SELECTION_FILE)
}

export function switchesRoot(dataRoot) {
    return resolve(workspacesRoot(dataRoot), SWITCHES_DIR)
}

export function switchReceiptPath(dataRoot, receiptId) {
    if (!/^[0-9a-f-]{36}$/i.test(receiptId)) throw new Error('Invalid switch receipt id')
    return resolve(switchesRoot(dataRoot), `${receiptId}.json`)
}

export function workspaceDirectory(dataRoot, workspaceId) {
    const id = Number(workspaceId)
    if (!Number.isInteger(id) || id < 1) throw new Error('Invalid workspace id')
    return resolve(workspacesRoot(dataRoot), String(id))
}

/** Exact engine root used by the current supervisor for workspace 1; same layout for new ids. */
export function engineRootFor(dataRoot, workspaceId) {
    return resolve(workspaceDirectory(dataRoot, workspaceId), 'engine')
}

export function ownerPath(dataRoot, workspaceId) {
    return resolve(workspaceDirectory(dataRoot, workspaceId), OWNER_FILE)
}

/**
 * Legacy workspace 1 keeps the install-level app.db. Newer workspaces get an owned
 * app.db under their directory once root opens it — this package never relocates
 * the existing workspace 1 database.
 */
export function appDatabasePath(dataRoot, workspaceId) {
    const id = Number(workspaceId)
    if (id === LEGACY_WORKSPACE_ID) return resolve(dataRoot, 'app.db')
    return resolve(workspaceDirectory(dataRoot, id), 'app.db')
}

export function assertInsideWorkspaces(dataRoot, candidate) {
    const root = workspacesRoot(dataRoot)
    const resolved = resolve(candidate)
    const rel = relative(root, resolved)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error('Workspace path escapes the workspaces root')
    }
    return resolved
}

export async function atomicPrivateJSON(path, value) {
    const temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
    await chmod(path, 0o600)
}

export async function readJSON(path) {
    return JSON.parse(await readFile(path, 'utf8'))
}

export async function pathExists(path) {
    try {
        await access(path, fsConstants.F_OK)
        return true
    } catch {
        return false
    }
}

/**
 * Refuses to treat an on-disk directory as this workspace unless the owner marker
 * matches installId + workspaceId. Same-name directories without a marker are
 * `foreign` and are never adopted.
 */
export async function inspectWorkspacePath(dataRoot, installId, workspaceId) {
    const dir = workspaceDirectory(dataRoot, workspaceId)
    const engine = engineRootFor(dataRoot, workspaceId)
    const marker = ownerPath(dataRoot, workspaceId)
    try {
        const stat = await lstat(dir)
        if (!stat.isDirectory()) return { status: 'corrupt', dir, engine, reason: 'Workspace path is not a directory.' }
    } catch (error) {
        if (error && error.code === 'ENOENT') return { status: 'missing', dir, engine, reason: 'Workspace folder is missing.' }
        throw error
    }
    let owner
    try {
        owner = await readJSON(marker)
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            // Legacy workspace 1 may predate the marker: engine/desktop-owner.json is the authority.
            if (workspaceId === LEGACY_WORKSPACE_ID) {
                const legacyOwner = resolve(engine, 'desktop-owner.json')
                try {
                    const legacy = await readJSON(legacyOwner)
                    if (legacy.installId === installId && legacy.workspaceId === LEGACY_WORKSPACE_ID) {
                        return { status: 'ready', dir, engine, reason: null, legacy: true }
                    }
                    return { status: 'foreign', dir, engine, reason: 'This folder belongs to another install.' }
                } catch (legacyError) {
                    if (legacyError && legacyError.code === 'ENOENT') {
                        return { status: 'ready', dir, engine, reason: null, legacy: true, uninitializedEngine: true }
                    }
                    return { status: 'corrupt', dir, engine, reason: 'Workspace ownership could not be read.' }
                }
            }
            return { status: 'foreign', dir, engine, reason: 'This folder is not an owned workspace.' }
        }
        return { status: 'corrupt', dir, engine, reason: 'Workspace ownership could not be read.' }
    }
    if (!owner || owner.installId !== installId || Number(owner.workspaceId) !== Number(workspaceId)) {
        return { status: 'foreign', dir, engine, reason: 'This folder belongs to another workspace.' }
    }
    return { status: 'ready', dir, engine, reason: null }
}

export async function ensureOwnedWorkspaceDirectory(dataRoot, installId, workspaceId, now = new Date().toISOString()) {
    const inspection = await inspectWorkspacePath(dataRoot, installId, workspaceId)
    if (inspection.status === 'foreign' || inspection.status === 'corrupt') {
        const error = new Error(inspection.reason || 'Workspace path is not usable')
        error.code = inspection.status === 'foreign' ? 'path_foreign' : 'path_corrupt'
        throw error
    }
    const dir = workspaceDirectory(dataRoot, workspaceId)
    const engine = engineRootFor(dataRoot, workspaceId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await mkdir(engine, { recursive: true, mode: 0o700 })
    if (!(await pathExists(ownerPath(dataRoot, workspaceId)))) {
        await writeFile(
            ownerPath(dataRoot, workspaceId),
            JSON.stringify({ version: CONTRACT_VERSION, installId, workspaceId: Number(workspaceId), createdAt: now }),
            { flag: 'wx', mode: 0o600 },
        )
    }
    return { dir, engine }
}

export async function ensureWorkspacesLayout(dataRoot) {
    await mkdir(workspacesRoot(dataRoot), { recursive: true, mode: 0o700 })
    await mkdir(switchesRoot(dataRoot), { recursive: true, mode: 0o700 })
}

export async function resolveRealDataRoot(dataRoot) {
    return realpath(dataRoot)
}
