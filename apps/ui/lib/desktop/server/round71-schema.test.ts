import { createClient } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { desktopAuxiliaryStore } from './auxiliary/store'
import { initializeDesktopRound71 } from './round71-schema'

it('lets a GitHub token be saved beside the keys already there, and applies once', async () => {
    // A file, not memory: the migration runs in a transaction, which opens its own connection.
    const dir = await mkdtemp(join(tmpdir(), 'rerun-round71-'))
    const db = createClient({ url: `file:${join(dir, 'app.db')}` })
    try {
    await db.executeMultiple(`CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL);
        CREATE TABLE desktop_auxiliary_credentials (purpose TEXT PRIMARY KEY CHECK(purpose IN ('search','transcription')), revision TEXT NOT NULL, ciphertext TEXT);
        INSERT INTO desktop_auxiliary_credentials VALUES('search','r1','kept');`)
    await initializeDesktopRound71(db)
    await initializeDesktopRound71(db)
    expect((await db.execute("SELECT ciphertext FROM desktop_auxiliary_credentials WHERE purpose='search'")).rows[0]!.ciphertext).toBe('kept')
    const store = desktopAuxiliaryStore(db, () => Buffer.alloc(32, 7))
    await store.change({ purpose: 'github-read', expectedRevision: 'unconfigured', key: 'github_pat_synthetic_token_0123456789' })
    expect((await store.read('github-read')).key).toBe('github_pat_synthetic_token_0123456789')
    // The list a screen gets says only that it is saved.
    expect((await store.list()).find(row => row.purpose === 'github-read')).toMatchObject({ configured: true })
    expect(JSON.stringify(await store.list())).not.toContain('github_pat_')
    } finally { db.close(); await rm(dir, { recursive: true, force: true }) }
})
