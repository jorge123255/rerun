import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createInProcessWorkspaceBridge } from './adapters'
import { desktopWorkspaceHandlers } from './api'
import { DESKTOP_LOCAL_WORKSPACES_MIGRATION } from './schema'

const roots: string[] = []

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function harness(portOverrides: Record<string, unknown> = {}) {
    const dataRoot = await mkdtemp(join(tmpdir(), 'rerun-ws-server-'))
    roots.push(dataRoot)
    const installId = randomUUID()
    let runtime = { workspaceId: 1, launchNonce: 'n', dataRoot }
    const ports = {
        freezeAdmissions: async () => true,
        unfreezeAdmissions: async () => {},
        flushDrafts: async () => ({ saved: true }),
        stopAndDrain: async () => {},
        bindAndStart: async (workspaceId: number) => {
            runtime = { workspaceId, launchNonce: 'n2', dataRoot }
            return runtime
        },
        verifyRuntimeIdentity: async (workspaceId: number) => runtime.workspaceId === workspaceId,
        isQuitInProgress: () => false,
        ...portOverrides,
    }
    const main = await createInProcessWorkspaceBridge({ dataRoot, installId, ports })
    // Seed happens on first list/create via coordinator readCatalog → seedLegacyCatalog
    await main.list()
    return { dataRoot, installId, main, handlers: desktopWorkspaceHandlers({ main }) }
}

describe('desktop local workspaces server adapters', () => {
    it('exports additive migration identity for root', () => {
        expect(DESKTOP_LOCAL_WORKSPACES_MIGRATION.version).toBe(25)
        expect(DESKTOP_LOCAL_WORKSPACES_MIGRATION.id).toBe('local-workspace-catalog')
        expect(DESKTOP_LOCAL_WORKSPACES_MIGRATION.sql).toContain('desktop_local_workspaces')
        expect(DESKTOP_LOCAL_WORKSPACES_MIGRATION.sql).toContain('INSERT OR IGNORE INTO desktop_local_workspaces')
    })

    it('creates and renames through handlers without switching', async () => {
        const { handlers } = await harness()
        const created = await handlers.create({ requestId: randomUUID(), name: 'Northwind', iconCatalogId: null })
        expect(created).toMatchObject({ ok: true, switched: false })
        if (!('ok' in created) || created.ok !== true) throw new Error('expected create ok')
        const renamed = await handlers.rename({
            requestId: randomUUID(),
            workspaceId: created.workspace.workspaceId,
            name: 'Northwind Labs',
        })
        expect(renamed).toMatchObject({ ok: true })
        if (!('ok' in renamed) || renamed.ok !== true) throw new Error('expected rename ok')
        expect(renamed.workspace.name).toBe('Northwind Labs')
        const listed = await handlers.list()
        if ('ok' in listed && listed.ok === false) throw new Error('list failed')
        expect(listed.selection.workspaceId).toBe(1)
    })

    it('switch publishes exact identity and preserves request idempotency', async () => {
        const { handlers } = await harness()
        const created = await handlers.create({ requestId: randomUUID(), name: 'Other', iconCatalogId: null })
        if (!('ok' in created) || created.ok !== true) throw new Error('create failed')
        const requestId = randomUUID()
        const first = await handlers.switchTo({ requestId, workspaceId: created.workspace.workspaceId })
        expect(first).toMatchObject({ ok: true })
        if (!('ok' in first) || first.ok !== true) throw new Error('switch failed')
        expect(first.receipt.phase).toBe('published')
        expect(first.receipt.toWorkspaceId).toBe(created.workspace.workspaceId)
        const second = await handlers.switchTo({ requestId, workspaceId: created.workspace.workspaceId })
        expect(second).toMatchObject({ ok: true })
        if (!('ok' in second) || second.ok !== true) throw new Error('replay failed')
        expect(second.receipt.receiptId).toBe(first.receipt.receiptId)
    })

    it('missing main bridge fails closed with authority_missing', async () => {
        const handlers = desktopWorkspaceHandlers({ main: null })
        const listed = await handlers.list()
        expect(listed).toMatchObject({ ok: false, code: 'authority_missing', authority: 'W1-A4' })
    })

    it('rollback before drain when drafts cannot flush', async () => {
        const { handlers } = await harness({
            flushDrafts: async () => ({ saved: false }),
        })
        const created = await handlers.create({ requestId: randomUUID(), name: 'Drain', iconCatalogId: null })
        if (!('ok' in created) || created.ok !== true) throw new Error('create failed')
        const result = await handlers.switchTo({ requestId: randomUUID(), workspaceId: created.workspace.workspaceId })
        expect(result).toMatchObject({ ok: false, code: 'draft_flush_failed' })
        const listed = await handlers.list()
        if ('ok' in listed && listed.ok === false) throw new Error('list failed')
        expect(listed.selection.workspaceId).toBe(1)
        expect(listed.openReceipt).toBeNull()
    })
})
