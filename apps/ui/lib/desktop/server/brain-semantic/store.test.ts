import { createClient } from '@libsql/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { DesktopBrainSemanticIndexEntry, DesktopBrainSemanticPending } from '@rerun/contracts'
import { desktopBrainSemanticSchema } from './schema'
import { desktopBrainSemanticStore } from './store'

const dbs: ReturnType<typeof createClient>[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

const entry: DesktopBrainSemanticIndexEntry = {
    chunk: { id: crypto.randomUUID(), slug: 'pricing', heading: 'Overview', ordinal: 0, content: 'Pricing is public.', textHash: 'b'.repeat(32), text: 'Pricing (offering) > Overview\n\nPricing is public.' },
    pageHash: 'a'.repeat(32), backendFingerprint: 'c'.repeat(64), vector: [1, 0],
}
const pending: DesktopBrainSemanticPending = { chunk: entry.chunk, pageHash: entry.pageHash, backendFingerprint: entry.backendFingerprint, attempts: 0 }

describe('desktop Brain semantic store', () => {
    it('persists derived entries and pending work with exact identities', async () => {
        const db = createClient({ url: 'file::memory:' })
        dbs.push(db)
        await db.executeMultiple(desktopBrainSemanticSchema)
        const store = desktopBrainSemanticStore(db)
        await store.queue(pending)
        expect(await store.pending()).toEqual([pending])
        await store.write(entry)
        expect(await store.list()).toEqual([entry])
        await store.removePending([entry.chunk.id])
        expect(await store.pending()).toEqual([])
        await store.remove([entry.chunk.id])
        expect(await store.list()).toEqual([])
    })

    it('removes a whole page and its pending work without touching another slug', async () => {
        const db = createClient({ url: 'file::memory:' })
        dbs.push(db)
        await db.executeMultiple(desktopBrainSemanticSchema)
        const store = desktopBrainSemanticStore(db)
        await store.queue(pending)
        await store.write(entry)
        const other = { ...entry, chunk: { ...entry.chunk, id: crypto.randomUUID(), slug: 'other' } }
        await store.queue({ ...pending, chunk: other.chunk })
        await store.write(other)
        await store.removePage('pricing')
        expect((await store.list()).map(item => item.chunk.slug)).toEqual(['other'])
        expect((await store.pending()).map(item => item.chunk.slug)).toEqual(['other'])
    })
})
