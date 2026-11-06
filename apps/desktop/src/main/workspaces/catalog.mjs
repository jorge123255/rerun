import { randomUUID, createHash } from 'node:crypto'
import {
    LEGACY_WORKSPACE_ID,
    CONTRACT_VERSION,
    atomicPrivateJSON,
    catalogPath,
    ensureOwnedWorkspaceDirectory,
    ensureWorkspacesLayout,
    inspectWorkspacePath,
    readJSON,
    selectionPath,
    pathExists,
    UUID, validWorkspaceId, persistenceError, inspectWorkspacesLayout,
} from './paths.mjs'
import { WORKSPACE_COPY, refusal } from './copy.mjs'

const NAME_MAX = 60
const ICON_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.webp$/


function publicRecord(record) {
    return {
        workspaceId: Number(record.workspaceId),
        name: record.name,
        iconCatalogId: record.iconCatalogId ?? null,
        directoryName: String(record.directoryName ?? record.workspaceId),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        pathStatus: record.pathStatus ?? 'ready',
    }
}

function nowIso() {
    return new Date().toISOString()
}

function normalizeName(name) {
    return typeof name === 'string' ? name.trim() : ''
}

function validateName(name) {
    const trimmed = normalizeName(name)
    if (!trimmed) return refusal('name_required', WORKSPACE_COPY.nameRequired)
    if (trimmed.length > NAME_MAX) return refusal('name_too_long', WORKSPACE_COPY.nameTooLong(NAME_MAX))
    return { ok: true, name: trimmed }
}

function validateIcon(iconCatalogId) {
    if (iconCatalogId == null || iconCatalogId === '') return { ok: true, iconCatalogId: null }
    if (typeof iconCatalogId !== 'string' || !ICON_RE.test(iconCatalogId)) {
        return refusal('unknown_icon', WORKSPACE_COPY.unknownIcon)
    }
    return { ok: true, iconCatalogId }
}

async function annotatePathStatus(dataRoot, installId, record) {
    const inspection = await inspectWorkspacePath(dataRoot, installId, record.workspaceId)
    return { ...record, pathStatus: inspection.status }
}

function operationFingerprint(operation, installId, payload) {
    return createHash('sha256').update(JSON.stringify([operation, installId, payload])).digest('hex')
}
function priorOperation(catalog, requestId, operation, fingerprint) {
    const prior = catalog.operations.find(row => row.requestId === requestId)
    if (!prior) return null
    return prior.operation === operation && prior.fingerprint === fingerprint
        ? prior.result : refusal('duplicate_request', 'That request was already used for a different workspace change.')
}
function saveOperation(catalog, input, operation, fingerprint, result) {
    catalog.operations.push({ requestId: input.requestId, operation, fingerprint, result })
}
export async function seedLegacyCatalog(dataRoot, installId, { name = 'My workspace', iconCatalogId = null } = {}) {
    if (!UUID.test(installId)) throw persistenceError()
    await ensureWorkspacesLayout(dataRoot)
    if (await pathExists(catalogPath(dataRoot))) return readCatalog(dataRoot, installId)
    if (await pathExists(selectionPath(dataRoot))) throw persistenceError('Workspace catalog is missing; recovery is required.')
    await ensureOwnedWorkspaceDirectory(dataRoot, installId, LEGACY_WORKSPACE_ID)
    const stamp = nowIso()
    const catalog = { version: CONTRACT_VERSION, installId, operations: [], workspaces: [{
        workspaceId: LEGACY_WORKSPACE_ID, name: normalizeName(name) || 'My workspace', iconCatalogId,
        directoryName: String(LEGACY_WORKSPACE_ID), createdAt: stamp, updatedAt: stamp,
    }] }
    const selection = { version: CONTRACT_VERSION, workspaceId: LEGACY_WORKSPACE_ID, publishedByReceiptId: null, selectedAt: stamp }
    await atomicPrivateJSON(catalogPath(dataRoot), catalog)
    await atomicPrivateJSON(selectionPath(dataRoot), selection)
    return readCatalog(dataRoot, installId)
}
export async function readCatalog(dataRoot, installId) {
    if (!await inspectWorkspacesLayout(dataRoot)) throw persistenceError('Workspace catalog has not been initialized.')
    const catalog = await readJSON(catalogPath(dataRoot))
    if (catalog.version !== CONTRACT_VERSION || catalog.installId !== installId || !UUID.test(installId)
        || !Array.isArray(catalog.workspaces) || catalog.workspaces.length < 1) throw persistenceError()
    const ids = new Set()
    for (const row of catalog.workspaces) {
        if (!validWorkspaceId(row.workspaceId) || ids.has(row.workspaceId) || row.directoryName !== String(row.workspaceId)
            || !validateName(row.name).ok || !validateIcon(row.iconCatalogId).ok
            || !Number.isFinite(Date.parse(row.createdAt)) || !Number.isFinite(Date.parse(row.updatedAt))) throw persistenceError()
        ids.add(row.workspaceId)
    }
    if (!ids.has(LEGACY_WORKSPACE_ID)) throw persistenceError()
    const operations = catalog.operations ?? []
    if (!Array.isArray(operations) || operations.length > 4096) throw persistenceError()
    const requests = new Set()
    for (const op of operations) {
        if (!UUID.test(op.requestId) || requests.has(op.requestId) || !['create', 'rename'].includes(op.operation)
            || !/^[a-f0-9]{64}$/.test(op.fingerprint) || op.result?.ok !== true || !ids.has(op.result.workspace?.workspaceId)) throw persistenceError()
        requests.add(op.requestId)
    }
    const selection = await readJSON(selectionPath(dataRoot))
    if (selection.version !== CONTRACT_VERSION || !ids.has(selection.workspaceId)
        || (selection.publishedByReceiptId !== null && !UUID.test(selection.publishedByReceiptId))
        || !Number.isFinite(Date.parse(selection.selectedAt))) throw persistenceError()
    const annotated = []
    for (const record of catalog.workspaces) annotated.push(await annotatePathStatus(dataRoot, installId, record))
    return { catalog: { ...catalog, operations, workspaces: annotated }, selection }
}

/** Public list projection: strips idempotency keys from catalog rows. */
export async function listCatalog(dataRoot, installId) {
    const { catalog, selection } = await readCatalog(dataRoot, installId)
    return {
        catalog: { version: catalog.version, installId: catalog.installId, workspaces: catalog.workspaces.map(publicRecord) },
        selection,
    }
}

export async function writeCatalog(dataRoot, catalog) {
    await atomicPrivateJSON(catalogPath(dataRoot), {
        version: CONTRACT_VERSION,
        installId: catalog.installId,
        operations: catalog.operations,
        workspaces: catalog.workspaces.map(({ pathStatus: _pathStatus, ...rest }) => rest),
    })
}

export async function writeSelection(dataRoot, selection) {
    await atomicPrivateJSON(selectionPath(dataRoot), {
        version: CONTRACT_VERSION,
        workspaceId: Number(selection.workspaceId),
        publishedByReceiptId: selection.publishedByReceiptId ?? null,
        selectedAt: selection.selectedAt,
    })
}

/**
 * Create is durable and idempotent on requestId. It never switches the active
 * workspace and never starts a runtime.
 */
export async function createWorkspace(dataRoot, installId, input, { nextId } = {}) {
    const nameCheck = validateName(input?.name)
    if (!nameCheck.ok) return nameCheck
    const iconCheck = validateIcon(input?.iconCatalogId)
    if (!iconCheck.ok) return iconCheck
    if (typeof input?.requestId !== 'string' || !UUID.test(input.requestId)) {
        return refusal('unsupported', WORKSPACE_COPY.createFailed)
    }

    const { catalog } = await readCatalog(dataRoot, installId)
    const fingerprint = operationFingerprint('create', installId, [nameCheck.name, iconCheck.iconCatalogId])
    const previous = priorOperation(catalog, input.requestId, 'create', fingerprint)
    if (previous) return previous
    if (catalog.operations.length >= 4096) return refusal('unsupported', WORKSPACE_COPY.createFailed)

    const allocate = typeof nextId === 'function'
        ? nextId
        : (current) => Math.max(...current.map(w => Number(w.workspaceId))) + 1
    const workspaceId = allocate(catalog.workspaces)
    if (!validWorkspaceId(workspaceId) || workspaceId < 2) {
        return refusal('unsupported', WORKSPACE_COPY.createFailed)
    }
    if (catalog.workspaces.some(w => Number(w.workspaceId) === workspaceId)) {
        return refusal('unsupported', WORKSPACE_COPY.createFailed)
    }

    const stamp = nowIso()
    try {
        await ensureOwnedWorkspaceDirectory(dataRoot, installId, workspaceId, stamp, { createRequestId: input.requestId })
    } catch (error) {
        const code = error?.code === 'path_foreign' || error?.code === 'path_corrupt' ? error.code : 'create_failed'
        if (code === 'path_foreign') return refusal('path_foreign', WORKSPACE_COPY.pathForeign)
        if (code === 'path_corrupt') return refusal('path_corrupt', WORKSPACE_COPY.pathCorrupt)
        return refusal('unsupported', WORKSPACE_COPY.createFailed)
    }

    const record = {
        workspaceId,
        name: nameCheck.name,
        iconCatalogId: iconCheck.iconCatalogId,
        directoryName: String(workspaceId),
        createdAt: stamp,
        updatedAt: stamp,
        pathStatus: 'ready',
        createRequestId: input.requestId,
    }
    catalog.workspaces.push(record)
    const result = { ok: true, workspace: publicRecord(record), switched: false }
    saveOperation(catalog, input, 'create', fingerprint, result)
    await writeCatalog(dataRoot, catalog)
    return result
}

export async function renameWorkspace(dataRoot, installId, input) {
    const nameCheck = validateName(input?.name)
    if (!nameCheck.ok) return nameCheck
    const iconProvided = Object.prototype.hasOwnProperty.call(input ?? {}, 'iconCatalogId')
    const iconCheck = iconProvided ? validateIcon(input.iconCatalogId) : { ok: true, iconCatalogId: undefined }
    if (!iconCheck.ok) return iconCheck
    if (typeof input?.requestId !== 'string' || !UUID.test(input.requestId)) {
        return refusal('unsupported', WORKSPACE_COPY.renameFailed)
    }
    const workspaceId = Number(input?.workspaceId)
    if (!validWorkspaceId(workspaceId)) return refusal('not_found', WORKSPACE_COPY.notFound)

    const { catalog } = await readCatalog(dataRoot, installId)
    const index = catalog.workspaces.findIndex(w => Number(w.workspaceId) === workspaceId)
    if (index < 0) return refusal('not_found', WORKSPACE_COPY.notFound)

    const current = catalog.workspaces[index]
    const fingerprint = operationFingerprint('rename', installId, [workspaceId, nameCheck.name, iconProvided ? iconCheck.iconCatalogId : '__unchanged__'])
    const previous = priorOperation(catalog, input.requestId, 'rename', fingerprint)
    if (previous) return previous
    if (catalog.operations.length >= 4096) return refusal('unsupported', WORKSPACE_COPY.renameFailed)

    const inspection = await inspectWorkspacePath(dataRoot, installId, workspaceId)
    if (inspection.status === 'missing') return refusal('path_missing', WORKSPACE_COPY.pathMissing)
    if (inspection.status === 'corrupt') return refusal('path_corrupt', WORKSPACE_COPY.pathCorrupt)
    if (inspection.status === 'foreign') return refusal('path_foreign', WORKSPACE_COPY.pathForeign)

    const updated = {
        ...current,
        name: nameCheck.name,
        iconCatalogId: iconProvided ? iconCheck.iconCatalogId : current.iconCatalogId,
        updatedAt: nowIso(),
        renameRequestId: input.requestId,
        pathStatus: inspection.status,
    }
    catalog.workspaces[index] = updated
    const result = { ok: true, workspace: publicRecord(updated) }
    saveOperation(catalog, input, 'rename', fingerprint, result)
    await writeCatalog(dataRoot, catalog)
    return result
}

export async function getWorkspace(dataRoot, installId, workspaceId) {
    const { catalog, selection } = await readCatalog(dataRoot, installId)
    const workspace = catalog.workspaces.find(w => Number(w.workspaceId) === Number(workspaceId))
    return { catalog, selection, workspace: workspace ? publicRecord(workspace) : null }
}

export function allocateWorkspaceId(workspaces) {
    return Math.max(LEGACY_WORKSPACE_ID, ...workspaces.map(w => Number(w.workspaceId))) + 1
}

export { LEGACY_WORKSPACE_ID, CONTRACT_VERSION, randomUUID, NAME_MAX }
