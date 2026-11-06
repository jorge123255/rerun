import { expect, test } from 'vitest'
import { captureDesktopCoworkerShareDatabase } from './capture.ts'
import { previewDesktopCoworkerShareDatabase } from './preview.ts'
import { restoreDesktopCoworkerShareDatabase } from './restore.ts'
import { DesktopCoworkerShareDatabaseError } from './errors.ts'
import { createDesktopCoworkerShareDatabaseInstallAdapter } from './adapters.ts'
import { logicalCreateTableSql } from './normalize.ts'

const snapshot = {
    tables: [{
        name: 'leads',
        columns: [
            { name: 'id', type: 'INTEGER', pk: true, notnull: true },
            { name: 'name', type: 'TEXT', pk: false, notnull: true },
        ],
        rows: [{ id: 1, name: 'Ada' }],
    }],
    views: [{
        id: 'v1',
        table: 'leads',
        name: 'All',
        position: 0,
        config: { layout: 'table', columns: ['id', 'name'] },
    }],
}

test('preview binds counts and digest; unavailable stays empty', () => {
    const preview = previewDesktopCoworkerShareDatabase(snapshot.tables, snapshot.views)
    expect(preview.available).toBe(true)
    expect(preview.contents.count).toBe(1)
    expect(preview.viewCount).toBe(1)
    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(previewDesktopCoworkerShareDatabase(snapshot.tables, snapshot.views, {
        available: false,
        reason: 'Database transfer is unavailable in this version. Existing tables stay on this Mac.',
    })).toMatchObject({ available: false, contents: { count: 0, bytes: 0 }, viewCount: 0, digest: null })
})

test('capture fails closed without authority and skips when database not included', async () => {
    await expect(captureDesktopCoworkerShareDatabase(null, { requestId: 'r1', includeDatabase: true })).resolves.toMatchObject({ unavailable: true })
    await expect(captureDesktopCoworkerShareDatabase({
        workspaceId: 1,
        agentId: 'agent-a',
        listPrivateSnapshot: async () => snapshot,
    }, { requestId: 'r1', includeDatabase: false })).resolves.toMatchObject({ unavailable: true })
})

test('capture excludes shared/system concerns by only accepting private snapshot authority output', async () => {
    const pkg = await captureDesktopCoworkerShareDatabase({
        workspaceId: 1,
        agentId: 'agent-a',
        listPrivateSnapshot: async () => snapshot,
    }, { requestId: 'capture-db', includeDatabase: true, capturedAt: '2026-11-06T19:00:00.000Z' })
    if ('unavailable' in pkg) throw new Error('expected package')
    expect(pkg.format).toBe('desktop-coworker-share-database')
    expect(pkg.tables[0]?.name).toBe('leads')
    expect(JSON.stringify(pkg)).not.toMatch(/shared\.db|system\.db|ATTACH|PRAGMA/i)
    expect(pkg.digest).toMatch(/^[a-f0-9]{64}$/)
})

test('restore fails closed unbound, rejects stale digest, installs then reuses without duplicates', async () => {
    const captured = await captureDesktopCoworkerShareDatabase({
        workspaceId: 1,
        agentId: 'agent-a',
        listPrivateSnapshot: async () => snapshot,
    }, { requestId: 'capture-db', includeDatabase: true, capturedAt: '2026-11-06T19:00:00.000Z' })
    if ('unavailable' in captured) throw new Error('expected package')

    expect(await restoreDesktopCoworkerShareDatabase(null, captured, {
        captureRequestId: 'capture-db',
        expectedDigest: captured.digest,
    })).toMatchObject({ status: 'unavailable' })

    await expect(restoreDesktopCoworkerShareDatabase({
        workspaceId: 1,
        destinationAgentId: 'agent-b',
        assertFreshPrivateDatabase: async () => {},
        installTable: async () => 'installed',
        installView: async () => 'installed',
    }, captured, { captureRequestId: 'capture-db', expectedDigest: '0'.repeat(64) })).rejects.toBeInstanceOf(DesktopCoworkerShareDatabaseError)

    const writes: string[] = []
    const authority = {
        workspaceId: 1,
        destinationAgentId: 'agent-b',
        assertFreshPrivateDatabase: async () => {},
        installTable: async ({ table, createTableSql }: { table: { name: string }; createTableSql: string }) => {
            expect(createTableSql).toBe(logicalCreateTableSql(captured.tables[0]!))
            const key = `table:${table.name}`
            if (writes.includes(key)) return 'reused' as const
            writes.push(key)
            return 'installed' as const
        },
        installView: async ({ view }: { view: { id: string } }) => {
            const key = `view:${view.id}`
            if (writes.includes(key)) return 'reused' as const
            writes.push(key)
            return 'installed' as const
        },
    }
    const first = await restoreDesktopCoworkerShareDatabase(authority, captured, {
        captureRequestId: 'capture-db',
        expectedDigest: captured.digest,
    })
    expect(first).toMatchObject({ status: 'installed', installedTables: ['leads'], installedViews: 1 })
    const second = await restoreDesktopCoworkerShareDatabase(authority, captured, {
        captureRequestId: 'capture-db',
        expectedDigest: captured.digest,
    })
    expect(second).toMatchObject({ status: 'reused', reusedTables: ['leads'], reusedViews: 1, installedTables: [], installedViews: 0 })
    expect(writes).toEqual(['table:leads', 'view:v1'])
})

test('restore reports partial and uncertain without claiming full success', async () => {
    const captured = await captureDesktopCoworkerShareDatabase({
        workspaceId: 1,
        agentId: 'agent-a',
        listPrivateSnapshot: async () => ({
            tables: [
                snapshot.tables[0]!,
                { name: 'notes', columns: [{ name: 'body', type: 'TEXT', pk: false, notnull: true }], rows: [{ body: 'hi' }] },
            ],
            views: [],
        }),
    }, { requestId: 'capture-db', includeDatabase: true, capturedAt: '2026-11-06T19:00:00.000Z' })
    if ('unavailable' in captured) throw new Error('expected package')

    const partial = await restoreDesktopCoworkerShareDatabase({
        workspaceId: 1,
        destinationAgentId: 'agent-b',
        assertFreshPrivateDatabase: async () => {},
        installTable: async ({ table }) => {
            if (table.name === 'notes') throw new Error('disk full')
            return 'installed'
        },
        installView: async () => 'installed',
    }, captured, { captureRequestId: 'capture-db', expectedDigest: captured.digest })
    expect(partial.status).toBe('partial')
    expect(partial.installedTables).toEqual(['leads'])
    expect(partial.reason).toMatch(/notes/)

    const uncertain = await restoreDesktopCoworkerShareDatabase({
        workspaceId: 1,
        destinationAgentId: 'agent-b',
        assertFreshPrivateDatabase: async () => {},
        installTable: async ({ table }) => {
            if (table.name === 'notes') throw new Error('uncertain acknowledgement')
            return 'installed'
        },
        installView: async () => 'installed',
    }, captured, { captureRequestId: 'capture-db', expectedDigest: captured.digest })
    expect(uncertain.status).toBe('uncertain')
})

test('install adapter refuses missing writers and non-fresh destinations', async () => {
    expect(() => createDesktopCoworkerShareDatabaseInstallAdapter({
        workspaceId: 1,
        destinationAgentId: 'agent-b',
        checkFresh: null,
        writeTable: null,
        writeView: null,
    })).toThrow(DesktopCoworkerShareDatabaseError)

    const adapter = createDesktopCoworkerShareDatabaseInstallAdapter({
        workspaceId: 1,
        destinationAgentId: 'agent-b',
        checkFresh: async () => ({ userTableCount: 2 }),
        writeTable: async () => 'installed',
        writeView: async () => 'installed',
    })
    await expect(adapter.assertFreshPrivateDatabase()).rejects.toBeInstanceOf(DesktopCoworkerShareDatabaseError)
})
