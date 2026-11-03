import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { createClient } from '@libsql/client'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import matter from 'gray-matter'
import type { DesktopMemoryCreate } from '@rerun/contracts'
import { deleteMemory, ftsExpression, indexMemory, keywordCoverage, listMemories, queryTerms } from '../db/repos/memories.js'
import { badRequest, HttpError, notFound } from '../lib/errors.js'
import { newId, nowIso } from '../lib/ids.js'
import { withKeyedLock } from '../lib/lock.js'
import { listMemoryFiles, readDesktopMemoryFile } from '../memory/files.js'
import { rankRecallHits, type RecalledMemory } from '../memory/store.js'
import { desktopMemoryPaths } from './memory-paths.js'

const noteId = /^[A-Za-z0-9_-]+$/

// Node exposes no unlinkat/renameat. Address the open directory by its filesystem ID on
// macOS (fd on Linux), so replacing a parent with a symlink cannot redirect our mutations.
async function inDirectory<T>(path: string, action: (pinned: string) => Promise<T>): Promise<T> {
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | (process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW)
    const dir = await open(path, flags)
    try {
        const stat = await dir.stat({ bigint: true })
        const pinned = process.platform === 'darwin' ? `/.vol/${stat.dev}/${stat.ino}` : `/proc/self/fd/${dir.fd}`
        return await action(pinned)
    } finally { await dir.close() }
}

// A hidden marker bridges each atomic SQLite batch with its Markdown rename. If the
// process stopped between them, the committed index tells us whether to publish or roll back.
async function recover(agentId: string, dir: string, hasIndex: boolean) {
    const pending = (await readdir(dir, { withFileTypes: true })).filter(entry => /^\.(adding|deleting)-[A-Za-z0-9_-]+$/.test(entry.name))
    if (!pending.length) return
    const indexed = new Set(hasIndex ? (await listMemories(agentId)).map(row => row.id) : [])
    for (const entry of pending) {
        if (!entry.isFile()) throw new HttpError(403, 'Unsafe coworker memory location.')
        const id = entry.name.slice(entry.name.indexOf('-') + 1)
        const marker = join(dir, entry.name)
        if (indexed.has(id)) {
            const target = join(dir, id + '.md')
            const existing = await lstat(target).catch((cause: NodeJS.ErrnoException) => {
                if (cause.code !== 'ENOENT') throw cause
                return null
            })
            if (existing) throw new HttpError(409, 'Conflicting coworker memory files.')
            await rename(marker, target)
        }
        else await unlink(marker)
    }
}

type Directory = { dir?: string; data?: string; memory: string; hasIndex: boolean }

function withMemoryStore<T>(agentId: string, mode: 'list' | 'create' | 'delete' | 'recall', action: (store: Directory) => Promise<T>) {
    return withKeyedLock('desktop-memories:' + agentId, async () => {
        const paths = await desktopMemoryPaths(agentId)
        if (!paths.hasMemory && mode !== 'create') return action(paths)
        return inDirectory(dirname(paths.memory), async parent => {
            const memory = join(parent, 'memory')
            if (!paths.hasMemory) await mkdir(memory, { mode: 0o700 })
            return inDirectory(memory, async dir => {
                if (mode !== 'recall') await recover(agentId, dir, paths.hasIndex)
                return action({ ...paths, dir, data: join(parent, 'data') })
            })
        })
    })
}

export function listDesktopMemory(agentId: string) {
    return withMemoryStore(agentId, 'list', async ({ dir, hasIndex }) => Promise.all([
        dir ? listMemoryFiles(agentId, dir) : [],
        hasIndex ? listMemories(agentId).catch(() => []) : [],
    ] as const))
}

type RecallStats = { createdAt: string; lastAccessedAt: string | null; accessCount: number; rank: number | null }

// Opening the regular engine client can migrate an old database. Use its same SQLite
// library in read-only mode, reading only statistics and BM25 ranks, never indexed paths.
async function readRecallStats(agentId: string, data: string, terms: string[]) {
    return inDirectory(data, async pinned => {
        const location = pathToFileURL(join(pinned, 'system.db'))
        location.searchParams.set('mode', 'ro')
        // The outer libSQL client URL takes a path. Pass the SQLite URI as that encoded path
        // so mode=ro reaches SQLite instead of being interpreted as a client query parameter.
        const reader = createClient({ url: 'file:' + encodeURIComponent(location.href) })
        try {
            const stats = new Map<string, RecallStats>()
            const info = await reader.execute('PRAGMA table_info(memories)')
            const columns = new Set(info.rows.map(row => row.name))
            if (!columns.size) return stats
            const fts = await reader.execute("SELECT 1 FROM sqlite_schema WHERE name = 'memories_fts'")
            const hasFts = fts.rows.length > 0
            const result = await reader.execute({
                sql: `SELECT m.id, m.created_at,
                    ${columns.has('access_count') ? 'm.access_count' : '0'} AS access_count,
                    ${columns.has('last_accessed_at') ? 'm.last_accessed_at' : 'NULL'} AS last_accessed_at,
                    ${hasFts ? 'f.rank' : 'NULL'} AS rank FROM memories m
                    ${hasFts ? 'LEFT JOIN (SELECT memory_id, rank FROM memories_fts WHERE memories_fts MATCH ?) f ON f.memory_id = m.id' : ''}
                    WHERE m.agent_id = ?`,
                args: hasFts ? [ftsExpression(terms), agentId] : [agentId],
            })
            for (const row of result.rows) {
                const id = String(row.id)
                stats.set(id, {
                    createdAt: String(row.created_at),
                    lastAccessedAt: row.last_accessed_at === null ? null : String(row.last_accessed_at),
                    accessCount: Number(row.access_count),
                    rank: row.rank === null ? null : Number(row.rank),
                })
            }
            return stats
        } finally { reader.close() }
    })
}

export function recallDesktopMemory(agentId: string, query: string, limit: number, includeDormant: boolean): Promise<RecalledMemory[]> {
    return withMemoryStore(agentId, 'recall', async ({ dir, data, hasIndex }) => {
        const terms = queryTerms(query)
        if (!dir || !terms.length) return []
        const [files, stats] = await Promise.all([
            listMemoryFiles(agentId, dir),
            hasIndex && data ? readRecallStats(agentId, data, terms) : new Map<string, RecallStats>(),
        ])
        const hits = files.flatMap(file => {
            const coverage = keywordCoverage(terms, file.content)
            if (!coverage) return []
            const row = stats.get(file.id)
            return [{
                ...file,
                createdAt: row?.createdAt ?? file.createdAt,
                lastAccessedAt: row?.lastAccessedAt ?? null,
                accessCount: row?.accessCount ?? 0,
                similarity: null,
                coverage,
                rank: row?.rank ?? Infinity,
            }]
        })
        hits.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
        return rankRecallHits(hits, limit, { includeDormant }).map(({ id, content, kind, tags, createdAt, strength }) =>
            ({ id, content, kind, tags, createdAt, strength }))
    })
}

async function findNote(dir: string, id: string) {
    try { return await readDesktopMemoryFile(join(dir, id + '.md')) }
    catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return null
        if (code === 'ELOOP') throw new HttpError(403, 'Unsafe coworker memory location.')
        throw cause
    }
}

export function addDesktopMemory(agentId: string, { content, kind, tags, requestId }: DesktopMemoryCreate) {
    return withMemoryStore(agentId, 'create', async ({ dir, memory, hasIndex }) => {
        if (!dir) throw notFound('memory directory')
        const id = requestId ?? newId()
        const existing = await findNote(dir, id)
        if (existing) {
            if (requestId && existing.id === id && existing.content === content && existing.kind === kind && isDeepStrictEqual(existing.tags, tags)) return id
            throw new HttpError(409, 'This note ID is already in use.')
        }
        if (hasIndex && (await listMemories(agentId)).some(row => row.id === id)) throw new HttpError(409, 'This note ID is already in use.')
        const createdAt = nowIso()
        const marker = join(dir, '.adding-' + id)
        await writeFile(marker, matter.stringify(`\n${content}\n`, { id, kind, tags, createdAt }), { flag: 'wx', mode: 0o600 })
        await indexMemory({ id, agentId, path: join(memory, id + '.md'), content, kind, createdAt, accessCount: 0, lastAccessedAt: createdAt }, null)
        await rename(marker, join(dir, id + '.md'))
        return id
    })
}

export function removeDesktopMemory(agentId: string, id: string) {
    if (!noteId.test(id) || id === 'recall') throw badRequest('Invalid memory ID')
    return withMemoryStore(agentId, 'delete', async ({ dir, hasIndex }) => {
        if (!dir || (await findNote(dir, id))?.id !== id) throw notFound('memory')
        const marker = join(dir, '.deleting-' + id)
        await rename(join(dir, id + '.md'), marker)
        if (hasIndex) await deleteMemory(agentId, id)
        await unlink(marker)
    })
}
