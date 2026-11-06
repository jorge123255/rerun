import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ensureDesktopCoworkerShareSchema } from './schema'
import { createDesktopCoworkerShareAttemptStore } from './attempts'

let directory = '', db: Client
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(),'rerun-share-attempts-')); db = createClient({ url: `file:${join(directory,'app.db')}` }); await ensureDesktopCoworkerShareSchema(db) })
afterEach(async () => { db.close(); await rm(directory,{ recursive: true,force: true }) })
test('saved import intent survives a file DB reopen and source-independent recovery is observational and workspace scoped', async () => {
    const input = { requestId: 'stable-import',snapshotId: 'a'.repeat(32),expectedDigest: 'b'.repeat(64),targetWorkspaceId: 7 }
    const own = createDesktopCoworkerShareAttemptStore(db,7,'source')
    await own({ mode: 'remember',kind: 'import',input })
    db.close(); db = createClient({ url: `file:${join(directory,'app.db')}` })
    const recovered = createDesktopCoworkerShareAttemptStore(db,7,'portable-import')
    expect(await recovered({ mode: 'list',kind: 'import',workspaceWide: true })).toEqual({ attempts: [input] })
    expect(await recovered({ mode: 'list',kind: 'import' })).toEqual({ attempts: [] })
    expect(await createDesktopCoworkerShareAttemptStore(db,8,'portable-import')({ mode: 'list',kind: 'import',workspaceWide: true })).toEqual({ attempts: [] })
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_coworker_share_receipts')).rows[0]!.count).toBe(0)
    await expect(createDesktopCoworkerShareAttemptStore(db,7,'source')({ mode: 'remember',kind: 'import',input: { ...input,expectedDigest: 'c'.repeat(64) } })).rejects.toMatchObject({ status: 409 })
    await expect(recovered({ mode: 'remember',kind: 'import',input: { ...input,targetWorkspaceId: 8 } })).rejects.toMatchObject({ status: 404 })
    await recovered({ mode: 'forget',kind: 'import',input })
    expect(await createDesktopCoworkerShareAttemptStore(db,7,'source')({ mode: 'list',kind: 'import' })).toEqual({ attempts: [] })
})
test('a corrupted intent cannot be returned as a recoverable identity', async () => {
    const attempts = createDesktopCoworkerShareAttemptStore(db,1,'source')
    const input = { requestId: 'saved',snapshotId: 'a'.repeat(32),expectedDigest: 'b'.repeat(64),targetWorkspaceId: 1 }
    await attempts({ mode: 'remember',kind: 'import',input })
    await db.execute("UPDATE desktop_coworker_share_attempts SET fingerprint='corrupt'")
    await expect(attempts({ mode: 'list',kind: 'import' })).rejects.toMatchObject({ status: 503 })
})
