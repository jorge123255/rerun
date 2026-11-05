import { existsSync } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { dataDir, pathSegment } from '../config/paths.js'
import { HttpError, notFound } from '../lib/errors.js'
import { desktopApp } from './policy.js'

const work = new Map<string, number>()
const deleting = new Set<string>()
const deleted = new Set<string>()
const keyOf = (id: string) => `${dataDir()}\0${id}`
const noop = () => {}
export const desktopDeletionPath = (id: string) => resolve(dataDir(), '.deleting', pathSegment(id, 'agent id'))
export const desktopDeletedPath = (id: string) => resolve(dataDir(), '.deleted-agents', pathSegment(id, 'agent id'))

export function desktopDeletionPending(id: string) {
    return existsSync(desktopDeletionPath(id))
}
export function desktopDeletionActive(id: string) { return deleting.has(keyOf(id)) || desktopDeletionPending(id) || deleted.has(keyOf(id)) || existsSync(desktopDeletedPath(id)) }

export function assertDesktopAgentNotDeleted(id: string) {
    if (desktopApp() && (deleted.has(keyOf(id)) || existsSync(desktopDeletedPath(id)))) throw notFound('agent')
}

export async function persistDesktopAgentDeletion(id: string) {
    const marker = desktopDeletedPath(id)
    await mkdir(dirname(marker), { recursive: true, mode: 0o700 })
    const parent = await lstat(dirname(marker))
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe coworker deletion receipt directory')
    const file = await open(marker, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return null
        throw error
    })
    if (file) { try { await file.sync() } finally { await file.close() } }
    else {
        const existing = await lstat(marker)
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Unsafe coworker deletion receipt')
    }
}

// Requests cover admission before a run exists, and background work retains its own lease
// until every write has finished. Delete never cancels another coworker's work.
export function beginDesktopAgentWork(id: string): () => void {
    if (!desktopApp()) return noop
    const key = keyOf(id)
    if (deleting.has(key) || desktopDeletionPending(id)) throw new HttpError(409, 'This coworker is being deleted. Try again.')
    assertDesktopAgentNotDeleted(id)
    work.set(key, (work.get(key) ?? 0) + 1)
    let released = false
    return () => {
        if (released) return
        released = true
        const count = (work.get(key) ?? 1) - 1
        if (count) work.set(key, count)
        else work.delete(key)
    }
}

// Caller also holds the config lock, shared with duplication and learning registration.
export async function withDesktopAgentDeletion<T>(id: string, remove: () => Promise<T>): Promise<T> {
    const key = keyOf(id)
    if (deleting.has(key) || work.has(key)) throw new HttpError(409, 'This coworker is still working. Stop its replies or wait for them to finish, then try again.')
    deleting.add(key)
    try {
        const result = await remove()
        // Late callbacks cannot recreate databases for this immutable engine identity. After
        // process restart there are no callbacks, and request admission checks the missing folder.
        deleted.add(key)
        return result
    } finally { deleting.delete(key) }
}
