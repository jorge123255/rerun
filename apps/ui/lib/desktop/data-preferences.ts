import { z } from 'zod'
import type { DataSource } from '@/lib/data/source'
import { desktopDataBase, desktopDataStorageKey, type DesktopDataScope } from './data-scope'
import { holdDraftAdmission, isDesktopQuitting } from './draft-writes'

// Multiple browsers can show one table (including Expand). Preserve actual click order across
// them; a read waits for queued saves, and Quit waits for the write receipt before restarting.
const pending = new Map<string, Promise<void>>()
const responseSchema = z.object({ viewId: z.string().min(1).max(128).nullable() })
export function desktopPreferredView(scope: DesktopDataScope): NonNullable<DataSource['preferredView']> {
    const url = `${desktopDataBase(scope)}/preferred-view`
    const key = (table: string) => JSON.stringify([desktopDataStorageKey(scope), table])
    async function response(request: Promise<Response>) {
        const result = await request
        const body = await result.json().catch(() => null)
        if (!result.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Could not remember this view.')
        return body
    }
    return {
        read: async table => {
            await pending.get(key(table))
            const body = await response(fetch(`${url}?${new URLSearchParams({ table })}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) }))
            return responseSchema.parse(body).viewId
        },
        write: (table, viewId) => {
            if (isDesktopQuitting()) return Promise.reject(new Error('Rerun is closing. This view was not saved.'))
            const release = holdDraftAdmission()
            const queueKey = key(table)
            const work = (pending.get(queueKey) ?? Promise.resolve()).then(async () => {
                const body = await response(fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table, viewId }), signal: AbortSignal.timeout(10_000) }))
                if (body?.saved !== true) throw new Error('The preferred view was not confirmed as saved.')
            })
            const tail = work.then(() => {}, () => {})
            pending.set(queueKey, tail)
            void tail.finally(() => { if (pending.get(queueKey) === tail) pending.delete(queueKey); release() })
            return work
        },
    }
}
