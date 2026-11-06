import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
    createWorkspace,
    renameWorkspace,
    readCatalog,
    seedLegacyCatalog,
    inspectWorkspacePath,
    ensureOwnedWorkspaceDirectory,
    workspaceDirectory,
} from '../src/main/workspaces/index.mjs'

async function tempInstall() {
    const dataRoot = await mkdtemp(join(tmpdir(), 'rerun-ws-catalog-'))
    const installId = randomUUID()
    await seedLegacyCatalog(dataRoot, installId, { name: 'My workspace' })
    return { dataRoot, installId }
}

test('seeds legacy workspace 1 without relocating paths', async () => {
    const { dataRoot, installId } = await tempInstall()
    const { catalog, selection } = await readCatalog(dataRoot, installId)
    assert.equal(catalog.workspaces[0].workspaceId, 1)
    assert.equal(selection.workspaceId, 1)
    assert.equal(workspaceDirectory(dataRoot, 1), join(dataRoot, 'workspaces', '1'))
    await rm(dataRoot, { recursive: true, force: true })
})

test('create allocates exclusive owned directory and is idempotent on requestId', async () => {
    const { dataRoot, installId } = await tempInstall()
    const requestId = randomUUID()
    const first = await createWorkspace(dataRoot, installId, { requestId, name: 'Acme', iconCatalogId: 'amber-fluid-blob.webp' })
    assert.equal(first.ok, true)
    assert.equal(first.workspace.workspaceId, 2)
    assert.equal(first.switched, false)
    const inspection = await inspectWorkspacePath(dataRoot, installId, 2)
    assert.equal(inspection.status, 'ready')
    const second = await createWorkspace(dataRoot, installId, { requestId, name: 'Acme', iconCatalogId: 'amber-fluid-blob.webp' })
    assert.equal(second.ok, true)
    assert.equal(second.workspace.workspaceId, 2)
    assert.equal(second.workspace.name, 'Acme')
    await rm(dataRoot, { recursive: true, force: true })
})

test('refuses to adopt a same-name foreign directory', async () => {
    const { dataRoot, installId } = await tempInstall()
    const foreign = workspaceDirectory(dataRoot, 2)
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, 'owner.json'), JSON.stringify({ version: 1, installId: randomUUID(), workspaceId: 2, createdAt: new Date().toISOString() }))
    const result = await createWorkspace(dataRoot, installId, { requestId: randomUUID(), name: 'Taken', iconCatalogId: null })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'path_foreign')
    await rm(dataRoot, { recursive: true, force: true })
})

test('rename is idempotent and rejects empty names', async () => {
    const { dataRoot, installId } = await tempInstall()
    const bad = await renameWorkspace(dataRoot, installId, { requestId: randomUUID(), workspaceId: 1, name: '   ' })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'name_required')
    const requestId = randomUUID()
    const first = await renameWorkspace(dataRoot, installId, { requestId, workspaceId: 1, name: 'Renamed Co' })
    assert.equal(first.ok, true)
    assert.equal(first.workspace.name, 'Renamed Co')
    const second = await renameWorkspace(dataRoot, installId, { requestId, workspaceId: 1, name: 'Renamed Co' })
    assert.equal(second.ok, true)
    assert.equal(second.workspace.name, 'Renamed Co')
    await rm(dataRoot, { recursive: true, force: true })
})

test('ensureOwnedWorkspaceDirectory seals owner marker', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'rerun-ws-owner-'))
    const installId = randomUUID()
    await ensureOwnedWorkspaceDirectory(dataRoot, installId, 3)
    const inspection = await inspectWorkspacePath(dataRoot, installId, 3)
    assert.equal(inspection.status, 'ready')
    await rm(dataRoot, { recursive: true, force: true })
})
