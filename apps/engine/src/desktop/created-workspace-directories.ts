import { lstat, rmdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { openWithoutLinks } from './open-without-links.ts'

export type CreatedWorkspaceDirectory = { path: string; dev: bigint; ino: bigint }

export async function recordCreatedWorkspaceDirectory(path: string, pinnedPath: string): Promise<CreatedWorkspaceDirectory> {
    const info = await lstat(pinnedPath, { bigint: true })
    return { path, dev: info.dev, ino: info.ino }
}

export async function removeCreatedWorkspaceDirectories(created: CreatedWorkspaceDirectory[]): Promise<void> {
    for (const directory of [...created].reverse()) {
        const parent = await openWithoutLinks(dirname(directory.path), true).catch(() => null)
        if (!parent) continue
        try {
            const info = await parent.stat({ bigint: true })
            const pinned = process.platform === 'darwin' ? `/.vol/${info.dev}/${info.ino}` : `/proc/self/fd/${parent.fd}`
            const child = join(pinned, basename(directory.path))
            const current = await lstat(child, { bigint: true }).catch(() => null)
            if (current?.isDirectory() && current.dev === directory.dev && current.ino === directory.ino) {
                await rmdir(child).catch(() => {})
            }
        } catch {
            // Best effort: preserve anything we can no longer identify as ours.
        } finally { await parent.close().catch(() => {}) }
    }
}
