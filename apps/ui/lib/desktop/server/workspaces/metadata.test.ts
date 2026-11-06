import { createClient } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { writeDesktopWorkspaceIcon, readDesktopWorkspaceIconSelection } from '../workspace-icon'
import { readDesktopWorkspaceMetadataOutbox, acknowledgeDesktopWorkspaceMetadataOutbox } from './metadata'
const clients = new Set<ReturnType<typeof createClient>>()
const roots: string[] = []
afterEach(async () => {
    for (const db of clients) db.close()
    clients.clear()
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
function connect(path: string) { const db = createClient({ url: `file:${path}` }); clients.add(db); return db }
function close(db: ReturnType<typeof createClient>) { db.close(); clients.delete(db) }
async function database() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-metadata-outbox-')); roots.push(root)
    const path = join(root, 'workspace.db'), db = connect(path)
    await db.executeMultiple("CREATE TABLE desktop_workspace(id INTEGER PRIMARY KEY,name TEXT,updated_at TEXT); INSERT INTO desktop_workspace VALUES(1,'Original','2026-11-06T00:00:00.000Z');")
    return { db, path }
}
it('keeps a committed name/logo and exact cache-sync request after a lost acknowledgement; stale ACK cannot consume the newer change', async () => {
    const fixture = await database()
    let db = fixture.db
    await writeDesktopWorkspaceIcon(db, { name: 'First', catalogId: 'amber-fluid-blob.webp' })
    const first = await readDesktopWorkspaceMetadataOutbox(db)
    expect(first).toMatchObject({ name: 'First', iconCatalogId: 'amber-fluid-blob.webp' })
    close(db)
    db = connect(fixture.path)
    expect((await db.execute('SELECT name FROM desktop_workspace WHERE id=1')).rows[0].name).toBe('First')
    expect(await readDesktopWorkspaceIconSelection(db)).toMatchObject({ iconCatalogId: 'amber-fluid-blob.webp' })
    expect(await readDesktopWorkspaceMetadataOutbox(db)).toEqual(first)
    await writeDesktopWorkspaceIcon(db, { name: 'Second', catalogId: null })
    const second = await readDesktopWorkspaceMetadataOutbox(db)
    expect(second?.requestId).not.toBe(first?.requestId)
    await acknowledgeDesktopWorkspaceMetadataOutbox(db, first!.requestId)
    expect(await readDesktopWorkspaceMetadataOutbox(db)).toEqual(second)
    await acknowledgeDesktopWorkspaceMetadataOutbox(db, second!.requestId)
    expect(await readDesktopWorkspaceMetadataOutbox(db)).toBeNull()
    expect((await db.execute('SELECT name FROM desktop_workspace WHERE id=1')).rows[0].name).toBe('Second')
})
it('an outbox write failure rolls the whole name and logo transaction back', async () => {
    const { db } = await database()
    await writeDesktopWorkspaceIcon(db, { name: 'First', catalogId: 'amber-fluid-blob.webp' })
    const prior = await readDesktopWorkspaceMetadataOutbox(db)
    await db.execute("CREATE TRIGGER fail_metadata BEFORE UPDATE ON desktop_workspace_metadata_outbox BEGIN SELECT RAISE(ABORT,'metadata write failed'); END;")
    await expect(writeDesktopWorkspaceIcon(db, { name: 'Must roll back', catalogId: null })).rejects.toThrow('metadata write failed')
    expect((await db.execute('SELECT name FROM desktop_workspace WHERE id=1')).rows[0].name).toBe('First')
    expect(await readDesktopWorkspaceIconSelection(db)).toMatchObject({ iconCatalogId: 'amber-fluid-blob.webp', iconUploadId: null })
    expect(await readDesktopWorkspaceMetadataOutbox(db)).toEqual(prior)
})
