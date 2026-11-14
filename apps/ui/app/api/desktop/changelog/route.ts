import { changelogEntries, changelogSeen, DESKTOP_CHANGELOG_URL } from '@/lib/desktop/changelog'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { parsePublishedChangelog } from '@/lib/desktop/server/changelog-source'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import type { Client } from '@libsql/client'

export const dynamic = 'force-dynamic'
const cacheMs = 6 * 60 * 60 * 1000
const maxBytes = 2 * 1024 * 1024

async function readCache(db: Client) {
    const row = (await db.execute(`SELECT p.created_at, c.entries, c.fetched_at, c.seen_at
        FROM desktop_profile p LEFT JOIN desktop_changelog c ON p.id = c.id WHERE p.id = 1`)).rows[0]
    const seen = Date.parse(String(row?.seen_at ?? row?.created_at ?? ''))
    const seenAt = new Date(Number.isFinite(seen) ? seen : 0).toISOString()
    let entries: ReturnType<typeof changelogEntries.parse> = []
    let fetchedAt = 0
    try {
        entries = changelogEntries.parse(JSON.parse(String(row?.entries ?? '[]')))
        fetchedAt = Number(row?.fetched_at ?? 0)
    } catch { /* Fetch again. */ }
    return { entries, fetchedAt, seenAt }
}

async function fetchEntries(signal: AbortSignal) {
    const response = await fetch(DESKTOP_CHANGELOG_URL, {
        cache: 'no-store', redirect: 'error', credentials: 'omit', headers: { Accept: 'text/html' }, signal,
    })
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/html') || !response.body) {
        void response.body?.cancel().catch(() => {})
        throw new Error('Changelog unavailable')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
        for (;;) {
            const part = await reader.read()
            signal.throwIfAborted()
            if (part.done) break
            bytes += part.value.byteLength
            if (bytes > maxBytes) throw new Error('Changelog is too large')
            chunks.push(part.value)
        }
    } finally { void reader.cancel().catch(() => {}) }
    return parsePublishedChangelog(Buffer.concat(chunks, bytes).toString('utf8'))
}

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        const cache = await readCache(db)
        const startedAt = Date.now()
        let stale = false
        if (startedAt - cache.fetchedAt >= cacheMs) {
            const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)])
            try {
                const entries = await fetchEntries(signal)
                await db.execute({
                    sql: `INSERT INTO desktop_changelog (id, entries, fetched_at) VALUES (1, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET entries = excluded.entries, fetched_at = excluded.fetched_at
                        WHERE excluded.fetched_at >= desktop_changelog.fetched_at`,
                    args: [JSON.stringify(entries), startedAt],
                })
            } catch {
                stale = true
            }
        }
        const { entries, seenAt } = await readCache(db)
        return Response.json({ entries, seenAt, stale }, { headers: { 'cache-control': 'no-store' } })
    })
}

export function PATCH(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = changelogSeen.safeParse(await readDesktopJson(request, 1024))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a published update.')
        const { slug, publishedAt } = parsed.data
        const db = await openDesktopDatabase(runtime.dataRoot)
        const cache = await readCache(db)
        if (publishedAt <= cache.seenAt) return Response.json({ seenAt: cache.seenAt })
        if (!cache.entries.some(entry => entry.slug === slug && entry.publishedAt === publishedAt)) {
            throw new DesktopHttpError(409, 'This update is no longer in the local changelog.')
        }
        await db.execute({
            sql: 'UPDATE desktop_changelog SET seen_at = ? WHERE id = 1 AND (seen_at IS NULL OR seen_at < ?)',
            args: [publishedAt, publishedAt],
        })
        return Response.json({ seenAt: (await readCache(db)).seenAt })
    })
}
