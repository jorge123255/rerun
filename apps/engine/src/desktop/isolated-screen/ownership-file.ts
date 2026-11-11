import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { openWithoutLinks } from '../open-without-links.ts'
import { IsolatedScreenRefusal } from './refusal.ts'

export const UNUSED_SCREEN_MARKER = '.desktop-screen-unused.json'

export function unusedScreenMarkerText(id: string, dev: string, ino: string): string {
    return JSON.stringify([id, dev, ino])
}

export async function openOwnerFolder(path: string) {
    const handle = await openWithoutLinks(path, true)
    try {
        const stat = await handle.stat({ bigint: true })
        const uid = process.getuid?.()
        if (!stat.isDirectory() || uid === undefined || stat.uid !== BigInt(uid) || (stat.mode & 0o022n) !== 0n) {
            throw new IsolatedScreenRefusal('The screen owner folder could not be verified.', 'conflict')
        }
        const pinned = process.platform === 'darwin' ? `/.vol/${stat.dev}/${stat.ino}` : `/proc/self/fd/${handle.fd}`
        return { handle, pinned, dev: String(stat.dev), ino: String(stat.ino) }
    } catch (error) {
        await handle.close()
        throw error
    }
}

// Call only while creating a new agent directory, before publishing its config or index.
export async function writeUnusedScreenMarker(id: string, directory: string): Promise<void> {
    const folder = await openOwnerFolder(directory)
    try {
        const file = await open(join(folder.pinned, UNUSED_SCREEN_MARKER), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try {
            await file.writeFile(unusedScreenMarkerText(id, folder.dev, folder.ino), 'utf8')
            await file.sync()
        } finally { await file.close() }
        await folder.handle.sync()
    } finally { await folder.handle.close() }
}

