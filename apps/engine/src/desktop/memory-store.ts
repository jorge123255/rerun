import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { createClient, type Client } from '@libsql/client'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import matter from 'gray-matter'
import type { DesktopMemoryCreate } from '@rerun/contracts'
import { bumpMemoryAccess, deleteMemory, ftsExpression, indexMemory, keywordCoverage, listMemories, queryTerms } from '../db/repos/memories.js'
import { badRequest, HttpError, notFound } from '../lib/errors.js'
import { newId, nowIso } from '../lib/ids.js'
import { withKeyedLock } from '../lib/lock.js'
import { listMemoryFiles, readDesktopMemoryFile } from '../memory/files.js'
import { rankRecallHits, type RecalledMemory } from '../memory/store.js'
import { desktopMemoryPaths } from './memory-paths.js'
import { desktopMemoryChanged } from './semantic-memory/events.js'
import { desktopApp } from './policy.js'
import type { DesktopSemanticMutationResult } from '@rerun/contracts'

const noteId = /^[A-Za-z0-9_-]+$/


/** Bound by semantic-memory/runtime so clear can wipe the private vector index outside the memory lock. */
export type DesktopMemorySemanticClearPort = {
    notesCleared(agentId: string): Promise<DesktopSemanticMutationResult>
}

let semanticClearPort: DesktopMemorySemanticClearPort | null = null
const pendingSemanticClears = new Set<string>()

export function bindDesktopMemorySemanticClear(port: DesktopMemorySemanticClearPort | null) {
    semanticClearPort = port
}

async function wipeSemanticAfterClear(agentId: string) {
    if (!desktopApp()) return
    const port = semanticClearPort
    if (!port) throw new HttpError(503, 'Private memory index wipe is unavailable.')
    const result = await port.notesCleared(agentId)
    if (!result.accepted) {
        throw new HttpError(503, `Private memory index could not be cleared (${result.reason}).`)
    }
}

function markSemanticClearPending(agentId: string) {
    pendingSemanticClears.add(agentId)
}


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
async function recover(agentId: string, dir: string, hasIndex: boolean, data: string) {
    const clearing = await lstat(join(dir, '.clearing')).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== 'ENOENT') throw cause
        return null
    })
    if (clearing) {
        if (!clearing.isFile()) throw new HttpError(403, 'Unsafe coworker memory location.')
        await finishClear(agentId, dir, data, hasIndex)
    }
    const pending = (await readdir(dir, { withFileTypes: true })).filter(entry => /^\.(adding|deleting|writing|updating)-[A-Za-z0-9_-]+$/.test(entry.name))
    if (!pending.length) return
    const indexed = new Map(hasIndex ? (await listMemories(agentId)).map(row => [row.id, row]) : [])
    for (const entry of pending) {
        if (!entry.isFile()) throw new HttpError(403, 'Unsafe coworker memory location.')
        const id = entry.name.slice(entry.name.indexOf('-') + 1)
        const marker = join(dir, entry.name)
        if (entry.name.startsWith('.writing-')) await unlink(marker)
        else if (entry.name.startsWith('.updating-')) {
            const pendingNote = await readDesktopMemoryFile(marker)
            if (pendingNote.id !== id) throw new HttpError(409, 'Conflicting coworker memory files.')
            if (indexed.get(id)?.content === pendingNote.content) await rename(marker, join(dir, id + '.md'))
            else await unlink(marker)
        } else if (indexed.has(id)) {
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

function withMemoryStore<T>(agentId: string, mode: 'list' | 'create' | 'update' | 'delete' | 'clear' | 'recall' | 'chat', action: (store: Directory) => Promise<T>) {
    return withKeyedLock('desktop-memories:' + agentId, async () => {
        const mutation = mode === 'create' || mode === 'update' || mode === 'delete' || mode === 'clear' ? mode : null
        if (mutation) desktopMemoryChanged({ agentId, phase: 'before', mode: mutation })
        const paths = await desktopMemoryPaths(agentId)
        const result = !paths.hasMemory && mode !== 'create' ? await action(paths) : await inDirectory(dirname(paths.memory), async parent => {
            const memory = join(parent, 'memory')
            if (!paths.hasMemory) await mkdir(memory, { mode: 0o700 })
            return inDirectory(memory, async dir => {
                const data = join(parent, 'data')
                if (mode !== 'recall') await recover(agentId, dir, paths.hasIndex, data)
                return action({ ...paths, dir, data })
            })
        })
        if (mutation) desktopMemoryChanged({ agentId, phase: 'after', mode: mutation })
        return result
    }).then(async result => {
        // Semantic wipe runs only after the memory lock releases. notesCleared reads
        // canonical notes through listDesktopMemory and would deadlock inside the lock.
        if (pendingSemanticClears.delete(agentId)) await wipeSemanticAfterClear(agentId)
        return result
    })
}

export function reinforceDesktopMemories(agentId: string, noteIds: readonly string[], mode: 'full' | 'touch') {
    return withMemoryStore(agentId, 'recall', async ({ data, hasIndex }) => {
        if (!data || !hasIndex) return
        const indexed = new Set((await listMemories(agentId)).map(note => note.id))
        const owned = noteIds.filter(id => noteId.test(id) && indexed.has(id))
        if (owned.length) await withRecallIndex(data, 'rw', db => bumpMemoryAccess(agentId, owned, mode, db))
    })
}

export function listDesktopMemory(agentId: string) {
    return withMemoryStore(agentId, 'list', async ({ dir, hasIndex }) => Promise.all([
        dir ? listMemoryFiles(agentId, dir) : [],
        hasIndex ? listMemories(agentId).catch(() => []) : [],
    ] as const))
}

type RecallStats = { createdAt: string; lastAccessedAt: string | null; accessCount: number; rank: number | null }

// Use an existing, pinned index without running migrations or creating a database for legacy notes.
function withRecallIndex<T>(data: string, mode: 'ro' | 'rw', use: (client: Client) => Promise<T>) {
    return inDirectory(data, async pinned => {
        const location = pathToFileURL(join(pinned, 'system.db'))
        location.searchParams.set('mode', mode)
        // The outer libSQL URL takes a path. Pass the inner SQLite URI as that encoded path.
        const client = createClient({ url: 'file:' + encodeURIComponent(location.href) })
        try { return await use(client) }
        finally { client.close() }
    })
}

async function readRecallStats(reader: Client, agentId: string, terms: string[]) {
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
}

type DesktopRecallOptions = { includeDormant?: boolean; purpose?: 'chat' | 'curation' }

export function recallDesktopMemory(agentId: string, query: string, limit: number, { includeDormant, purpose }: DesktopRecallOptions): Promise<RecalledMemory[]> {
    return withMemoryStore(agentId, purpose === 'chat' ? 'chat' : 'recall', async ({ dir, data, hasIndex }) => {
        const terms = queryTerms(query)
        if (!dir || !terms.length) return []
        const [files, stats] = await Promise.all([
            listMemoryFiles(agentId, dir),
            hasIndex && data ? withRecallIndex(data, 'ro', db => readRecallStats(db, agentId, terms)) : new Map<string, RecallStats>(),
        ])
        const hits = files.flatMap(file => {
            const coverage = keywordCoverage(terms, file.content)
            if (!coverage) return []
            const canonical = noteId.test(file.id) && basename(file.path) === file.id + '.md'
            const row = canonical ? stats.get(file.id) : undefined
            // The curator can change a note by ID. Only indexed files with that canonical filename
            // were editable upstream; chat and the manual panel can also read file-only notes.
            if (purpose === 'curation' && !row) return []
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
        const top = rankRecallHits(hits, limit, { includeDormant })
        if (purpose === 'chat' && data) {
            const indexedIds = top.filter(hit => stats.has(hit.id) && basename(hit.path) === hit.id + '.md').map(hit => hit.id)
            if (indexedIds.length) {
                await withRecallIndex(data, 'rw', db => bumpMemoryAccess(agentId, indexedIds, 'touch', db)).catch(() => {})
            }
        }
        return top.map(({ id, content, kind, tags, createdAt, strength }) =>
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

// The curator may run concurrently with another chat. Only replace the exact note it read.
export function updateDesktopMemory(agentId: string, id: string, expectedContent: string, content: string) {
    if (!noteId.test(id) || id === 'recall') throw badRequest('Invalid memory ID')
    return withMemoryStore(agentId, 'update', async ({ dir, data, hasIndex }) => {
        const existing = dir ? await findNote(dir, id) : null
        if (!dir || !hasIndex || !data || existing?.id !== id) throw notFound('memory')
        if (existing.content !== expectedContent) throw new HttpError(409, 'The coworker memory changed.')
        const updatedAt = nowIso()
        const marker = join(dir, '.updating-' + id)
        const next = content.trim()
        const metadata = { id, kind: existing.kind, tags: existing.tags, createdAt: existing.createdAt, updatedAt }
        const temporary = join(dir, '.writing-' + id)
        await writeFile(temporary, matter.stringify(`\n${next}\n`, metadata), { flag: 'wx', mode: 0o600 })
        await rename(temporary, marker)
        await withRecallIndex(data, 'rw', async db => {
            const results = await db.batch([
                { sql: 'UPDATE memories SET content = ?, last_accessed_at = ?, embedding = NULL WHERE agent_id = ? AND id = ?', args: [next, updatedAt, agentId, id] },
                { sql: 'UPDATE memories_fts SET content = ? WHERE memory_id IN (SELECT id FROM memories WHERE agent_id = ? AND id = ?)', args: [next, agentId, id] },
            ], 'write')
            if (!results[0].rowsAffected) throw notFound('memory')
        })
        await rename(marker, join(dir, id + '.md'))
    })
}

export function removeDesktopMemory(agentId: string, id: string, expectedContent?: string) {
    if (!noteId.test(id) || id === 'recall') throw badRequest('Invalid memory ID')
    return withMemoryStore(agentId, 'delete', async ({ dir, hasIndex }) => {
        const existing = dir ? await findNote(dir, id) : null
        if (!dir || existing?.id !== id) throw notFound('memory')
        if (expectedContent !== undefined && existing.content !== expectedContent) throw new HttpError(409, 'The coworker memory changed.')
        const marker = join(dir, '.deleting-' + id)
        await rename(join(dir, id + '.md'), marker)
        if (hasIndex) await deleteMemory(agentId, id)
        await unlink(marker)
    })
}

async function clearMemoryIndex(agentId: string, data: string, hasIndex: boolean) {
    if (!hasIndex) return
    await withRecallIndex(data, 'rw', async db => {
        const schema = await db.execute("SELECT name FROM sqlite_schema WHERE name IN ('memories', 'memories_fts')")
        const tables = new Set(schema.rows.map(row => row.name))
        const statements = []
        if (tables.has('memories_fts')) statements.push({
            // The index is stored in this coworker's database. Clear its owned rows and orphaned
            // FTS entries, retaining any rows that still belong to another agent in a legacy DB.
            sql: tables.has('memories')
                ? 'DELETE FROM memories_fts WHERE memory_id IN (SELECT id FROM memories WHERE agent_id = ?) OR NOT EXISTS (SELECT 1 FROM memories WHERE memories.id = memories_fts.memory_id)'
                : 'DELETE FROM memories_fts',
            args: tables.has('memories') ? [agentId] : [],
        })
        if (tables.has('memories')) statements.push({ sql: 'DELETE FROM memories WHERE agent_id = ?', args: [agentId] })
        if (statements.length) await db.batch(statements, 'write')
    })
}

async function clearableFiles(dir: string) {
    // Select regular Markdown files directly. Neither legacy names nor frontmatter IDs determine
    // a mutation path, and links, directories, and non-memory files remain untouched.
    const entries = (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    const paths = entries.map(entry => join(dir, entry.name))
    for (const path of paths) {
        if (!(await lstat(path)).isFile()) throw new HttpError(403, 'Unsafe coworker memory location.')
    }
    return paths
}

async function finishClear(agentId: string, dir: string, data: string, hasIndex: boolean) {
    for (const path of await clearableFiles(dir)) await unlink(path)
    await clearMemoryIndex(agentId, data, hasIndex)
    await unlink(join(dir, '.clearing'))
    markSemanticClearPending(agentId)
}

// A confirmed clear is durable intent: after an interrupted request, finish the same clear before
// allowing another write. A single marker also covers legacy filenames and index-only remnants.
export function clearDesktopMemories(agentId: string) {
    return withMemoryStore(agentId, 'clear', async ({ dir, data, memory, hasIndex }) => {
        const index = data ?? join(dirname(memory), 'data')
        if (!dir) {
            await clearMemoryIndex(agentId, index, hasIndex)
            markSemanticClearPending(agentId)
            return
        }
        await clearableFiles(dir)
        const intent = await open(join(dir, '.clearing'), 'wx', 0o600)
        try { await intent.sync() }
        finally { await intent.close() }
        await finishClear(agentId, dir, index, hasIndex)
    })
}
