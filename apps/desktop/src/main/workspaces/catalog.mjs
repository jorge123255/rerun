import { randomUUID } from 'node:crypto'
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
    return String(name ?? '').trim()
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

export async function seedLegacyCatalog(dataRoot, installId, { name = 'My workspace', iconCatalogId = null } = {}) {
    await ensureWorkspacesLayout(dataRoot)
    await ensureOwnedWorkspaceDirectory(dataRoot, installId, LEGACY_WORKSPACE_ID)
    const stamp = nowIso()
    const catalog = {
        version: CONTRACT_VERSION,
        installId,
        workspaces: [
            {
                workspaceId: LEGACY_WORKSPACE_ID,
                name: normalizeName(name) || 'My workspace',
                iconCatalogId,
                directoryName: String(LEGACY_WORKSPACE_ID),
                createdAt: stamp,
                updatedAt: stamp,
                pathStatus: 'ready',
            },
        ],
    }
    const selection = {
        version: CONTRACT_VERSION,
        workspaceId: LEGACY_WORKSPACE_ID,
        publishedByReceiptId: null,
        selectedAt: stamp,
    }
    if (!(await pathExists(catalogPath(dataRoot)))) await atomicPrivateJSON(catalogPath(dataRoot), catalog)
    if (!(await pathExists(selectionPath(dataRoot)))) await atomicPrivateJSON(selectionPath(dataRoot), selection)
    return { catalog, selection }
}

export async function readCatalog(dataRoot, installId) {
    await ensureWorkspacesLayout(dataRoot)
    if (!(await pathExists(catalogPath(dataRoot)))) {
        return seedLegacyCatalog(dataRoot, installId)
    }
    const catalog = await readJSON(catalogPath(dataRoot))
    if (catalog.version !== CONTRACT_VERSION || catalog.installId !== installId) {
        throw new Error('Workspace catalog does not belong to this install')
    }
    if (!Array.isArray(catalog.workspaces) || catalog.workspaces.length < 1) {
        throw new Error('Workspace catalog is empty')
    }
    const legacy = catalog.workspaces.find(w => Number(w.workspaceId) === LEGACY_WORKSPACE_ID)
    if (!legacy) throw new Error('Legacy workspace 1 is missing from the catalog')

    let selection
    if (await pathExists(selectionPath(dataRoot))) {
        selection = await readJSON(selectionPath(dataRoot))
    } else {
        selection = {
            version: CONTRACT_VERSION,
            workspaceId: LEGACY_WORKSPACE_ID,
            publishedByReceiptId: null,
            selectedAt: nowIso(),
        }
        await atomicPrivateJSON(selectionPath(dataRoot), selection)
    }
    if (selection.installId && selection.installId !== installId) {
        throw new Error('Workspace selection does not belong to this install')
    }
    const annotated = []
    for (const record of catalog.workspaces) {
        annotated.push(await annotatePathStatus(dataRoot, installId, record))
    }
    return {
        catalog: { ...catalog, workspaces: annotated },
        selection: {
            version: CONTRACT_VERSION,
            workspaceId: Number(selection.workspaceId),
            publishedByReceiptId: selection.publishedByReceiptId ?? null,
            selectedAt: selection.selectedAt,
        },
    }
}

/** Public list projection: strips idempotency keys from catalog rows. */
export async function listCatalog(dataRoot, installId) {
    const { catalog, selection } = await readCatalog(dataRoot, installId)
    return {
        catalog: { ...catalog, workspaces: catalog.workspaces.map(publicRecord) },
        selection,
    }
}

export async function writeCatalog(dataRoot, catalog) {
    await atomicPrivateJSON(catalogPath(dataRoot), {
        version: CONTRACT_VERSION,
        installId: catalog.installId,
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
    if (typeof input?.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.requestId)) {
        return refusal('unsupported', WORKSPACE_COPY.createFailed)
    }

    const { catalog, selection } = await readCatalog(dataRoot, installId)
    const existing = catalog.workspaces.find(w => w.createRequestId === input.requestId)
    if (existing) {
        return { ok: true, workspace: publicRecord(await annotatePathStatus(dataRoot, installId, existing)), switched: false }
    }

    const allocate = typeof nextId === 'function'
        ? nextId
        : (current) => Math.max(...current.map(w => Number(w.workspaceId))) + 1
    const workspaceId = allocate(catalog.workspaces)
    if (!Number.isInteger(workspaceId) || workspaceId < 2) {
        return refusal('unsupported', WORKSPACE_COPY.createFailed)
    }
    if (catalog.workspaces.some(w => Number(w.workspaceId) === workspaceId)) {
        return refusal('unsupported', WORKSPACE_COPY.createFailed)
    }

    const stamp = nowIso()
    try {
        await ensureOwnedWorkspaceDirectory(dataRoot, installId, workspaceId, stamp)
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
    await writeCatalog(dataRoot, catalog)
    return { ok: true, workspace: publicRecord(record), switched: false }
}

export async function renameWorkspace(dataRoot, installId, input) {
    const nameCheck = validateName(input?.name)
    if (!nameCheck.ok) return nameCheck
    const iconProvided = Object.prototype.hasOwnProperty.call(input ?? {}, 'iconCatalogId')
    const iconCheck = iconProvided ? validateIcon(input.iconCatalogId) : { ok: true, iconCatalogId: undefined }
    if (!iconCheck.ok) return iconCheck
    if (typeof input?.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.requestId)) {
        return refusal('unsupported', WORKSPACE_COPY.renameFailed)
    }
    const workspaceId = Number(input?.workspaceId)
    if (!Number.isInteger(workspaceId) || workspaceId < 1) return refusal('not_found', WORKSPACE_COPY.notFound)

    const { catalog } = await readCatalog(dataRoot, installId)
    const index = catalog.workspaces.findIndex(w => Number(w.workspaceId) === workspaceId)
    if (index < 0) return refusal('not_found', WORKSPACE_COPY.notFound)

    const current = catalog.workspaces[index]
    if (current.renameRequestId === input.requestId) {
        return { ok: true, workspace: publicRecord(await annotatePathStatus(dataRoot, installId, current)) }
    }

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
    await writeCatalog(dataRoot, catalog)
    return { ok: true, workspace: publicRecord(updated) }
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
