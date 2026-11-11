import { constants } from 'node:fs'
import { mkdir, open, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir, pathSegment } from '../../config/paths.js'
import { desktopDeletionActive } from '../agent-lifecycle.js'
import { openWithoutLinks, readBoundedFileWithoutLinks } from '../open-without-links.js'
import { IsolatedScreenRefusal } from './refusal.js'
import { UNUSED_SCREEN_MARKER, openOwnerFolder, unusedScreenMarkerText, writeUnusedScreenMarker } from './ownership-file.js'

export { UNUSED_SCREEN_MARKER } from './ownership-file.js'
const usageDirectory = '.desktop-screen-usage'
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

async function agentPath(id: string, parent = 'agents') {
    return join(await realpath(dataDir()), parent, pathSegment(id, 'agent id'))
}

// Docker ownership survives a replaced or restored coworker directory.
async function rememberPossibleUse(id: string): Promise<void> {
    const directory = await realpath(dataDir())
    const root = await openOwnerFolder(directory)
    try {
        await mkdir(join(root.pinned, usageDirectory), { mode: 0o700 }).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        })
        const journal = await openOwnerFolder(join(directory, usageDirectory))
        try {
            const entry = await open(join(journal.pinned, pathSegment(id, 'agent id')),
                constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
            try {
                const info = await entry.stat()
                if (!info.isFile() || info.nlink !== 1) throw new Error('Invalid screen ownership journal')
                await entry.sync()
            } finally { await entry.close() }
            await journal.handle.sync()
        } finally { await journal.handle.close() }
        await root.handle.sync()
    } finally { await root.handle.close() }
}

async function mayHaveScreenResources(id: string): Promise<boolean> {
    try {
        const path = join(await realpath(dataDir()), usageDirectory, pathSegment(id, 'agent id'))
        const entry = await openWithoutLinks(path)
        await entry.close()
        return true
    } catch (error) {
        // An unreadable or linked journal entry cannot establish absence.
        return !missing(error)
    }
}

export async function recordUnusedScreen(id: string, directory?: string): Promise<void> {
    await writeUnusedScreenMarker(id, directory ?? await agentPath(id))
}

export async function knownUnusedScreen(id: string): Promise<boolean> {
    if (await mayHaveScreenResources(id)) return false
    try {
        let path = await agentPath(id)
        const folder = await openOwnerFolder(path).catch(async error => {
            if (!missing(error)) throw error
            path = await agentPath(id, '.deleting')
            return openOwnerFolder(path)
        })
        try {
            const bytes = await readBoundedFileWithoutLinks(join(path, UNUSED_SCREEN_MARKER), 512)
            const current = await openOwnerFolder(path)
            try {
                return current.dev === folder.dev && current.ino === folder.ino
                    && bytes.toString('utf8') === unusedScreenMarkerText(id, folder.dev, folder.ino)
            } finally { await current.handle.close() }
        } finally { await folder.handle.close() }
    } catch { return false }
}

// Consume the proof durably before the first Docker mutation. Once consumed, even a
// failed or interrupted allocation must be checked with Docker before deleting the agent.
export async function recordPossibleScreenResources(id: string): Promise<void> {
    if (desktopDeletionActive(id)) throw new IsolatedScreenRefusal('This coworker is being deleted.', 'refused')
    const folder = await openOwnerFolder(await agentPath(id))
    try {
        await rememberPossibleUse(id)
        await unlink(join(folder.pinned, UNUSED_SCREEN_MARKER)).catch(error => { if (!missing(error)) throw error })
        await folder.handle.sync()
        if (desktopDeletionActive(id)) throw new IsolatedScreenRefusal('This coworker is being deleted.', 'refused')
    } finally { await folder.handle.close() }
}
