import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import matter from 'gray-matter'
import type { DesktopMemoryCreate } from '@rerun/contracts'
import { deleteMemory, indexMemory, listMemories } from '../db/repos/memories.js'
import { badRequest, HttpError, notFound } from '../lib/errors.js'
import { newId, nowIso } from '../lib/ids.js'
import { withKeyedLock } from '../lib/lock.js'
import { listMemoryFiles, readDesktopMemoryFile } from '../memory/files.js'
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

type Directory = { dir?: string; memory: string; hasIndex: boolean }

function withMemoryStore<T>(agentId: string, create: boolean, action: (store: Directory) => Promise<T>) {
    return withKeyedLock('desktop-memories:' + agentId, async () => {
        const paths = await desktopMemoryPaths(agentId)
        if (!paths.hasMemory && !create) return action(paths)
        return inDirectory(dirname(paths.memory), async parent => {
            const memory = join(parent, 'memory')
            if (!paths.hasMemory) await mkdir(memory, { mode: 0o700 })
            return inDirectory(memory, async dir => {
                await recover(agentId, dir, paths.hasIndex)
                return action({ ...paths, dir })
            })
        })
    })
}

export function listDesktopMemory(agentId: string) {
    return withMemoryStore(agentId, false, async ({ dir, hasIndex }) => Promise.all([
        dir ? listMemoryFiles(agentId, dir) : [],
        hasIndex ? listMemories(agentId).catch(() => []) : [],
    ] as const))
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
    return withMemoryStore(agentId, true, async ({ dir, memory, hasIndex }) => {
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
    return withMemoryStore(agentId, false, async ({ dir, hasIndex }) => {
        if (!dir || (await findNote(dir, id))?.id !== id) throw notFound('memory')
        const marker = join(dir, '.deleting-' + id)
        await rename(join(dir, id + '.md'), marker)
        if (hasIndex) await deleteMemory(agentId, id)
        await unlink(marker)
    })
}
