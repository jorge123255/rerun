import 'server-only'

import type { Client } from '@libsql/client'
import { desktopBrainSemanticIndexEntrySchema, desktopBrainSemanticPendingSchema, type DesktopBrainSemanticIndexEntry, type DesktopBrainSemanticPending } from '@rerun/contracts'

export function desktopBrainSemanticStore(db: Client) {

    return {
        async list(): Promise<DesktopBrainSemanticIndexEntry[]> {
            const rows = (await db.execute({ sql: 'SELECT entry FROM desktop_brain_semantic_chunks', args: [] })).rows
            return rows.map(row => desktopBrainSemanticIndexEntrySchema.parse(JSON.parse(String(row.entry))))
        },

        async write(entry: DesktopBrainSemanticIndexEntry): Promise<void> {
            const parsed = desktopBrainSemanticIndexEntrySchema.parse(entry)
            await db.execute({
                sql: `INSERT INTO desktop_brain_semantic_chunks(chunk_id,page_hash,backend_fingerprint,entry,updated_at) VALUES(?,?,?,?,?)
                      ON CONFLICT(chunk_id) DO UPDATE SET page_hash=excluded.page_hash,backend_fingerprint=excluded.backend_fingerprint,entry=excluded.entry,updated_at=excluded.updated_at`,
                args: [parsed.chunk.id, parsed.pageHash, parsed.backendFingerprint, JSON.stringify(parsed), new Date().toISOString()],
            })
        },

        async remove(chunkIds: readonly string[]): Promise<void> {
            for (const id of chunkIds) await db.execute({ sql: 'DELETE FROM desktop_brain_semantic_chunks WHERE chunk_id = ?', args: [id] })
        },

        async removePage(slug: string): Promise<void> {
            const rows = (await db.execute({ sql: 'SELECT chunk_id,entry FROM desktop_brain_semantic_chunks', args: [] })).rows
            for (const row of rows) {
                const entry = desktopBrainSemanticIndexEntrySchema.parse(JSON.parse(String(row.entry)))
                if (entry.chunk.slug === slug) await db.execute({ sql: 'DELETE FROM desktop_brain_semantic_chunks WHERE chunk_id = ?', args: [entry.chunk.id] })
            }
            const pending = (await db.execute({ sql: 'SELECT chunk_id,pending FROM desktop_brain_semantic_pending', args: [] })).rows
            for (const row of pending) if (desktopBrainSemanticPendingSchema.parse(JSON.parse(String(row.pending))).chunk.slug === slug) await db.execute({ sql: 'DELETE FROM desktop_brain_semantic_pending WHERE chunk_id=?', args: [String(row.chunk_id)] })
        },

        async pending(): Promise<DesktopBrainSemanticPending[]> {
            const rows = (await db.execute({ sql: 'SELECT pending FROM desktop_brain_semantic_pending', args: [] })).rows
            return rows.map(row => desktopBrainSemanticPendingSchema.parse(JSON.parse(String(row.pending))))
        },

        async queue(pending: DesktopBrainSemanticPending): Promise<void> {
            const parsed = desktopBrainSemanticPendingSchema.parse(pending)
            await db.execute({
                sql: `INSERT INTO desktop_brain_semantic_pending(chunk_id,pending,updated_at) VALUES(?,?,?)
                      ON CONFLICT(chunk_id) DO UPDATE SET pending=excluded.pending,updated_at=excluded.updated_at`,
                args: [parsed.chunk.id, JSON.stringify(parsed), new Date().toISOString()],
            })
        },

        async removePending(chunkIds: readonly string[]): Promise<void> {
            for (const id of chunkIds) await db.execute({ sql: 'DELETE FROM desktop_brain_semantic_pending WHERE chunk_id = ?', args: [id] })
        },
    }
}
