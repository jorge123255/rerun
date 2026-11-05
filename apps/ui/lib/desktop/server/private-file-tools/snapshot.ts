import 'server-only'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hashText } from '@/lib/files/editable'
import { boundedPrivateText, PRIVATE_TEXT_BYTES, privateTextPath } from './semantics'

type Directory = { path: string; dev: bigint; ino: bigint; uid: bigint }
export type PrivateFileLocation = { directories: Directory[]; target: string }
export type PrivateFileSnapshot = PrivateFileLocation & {
    content: string; hash: string; identity: string; version: string; mtime: string; size: number; truncated: false
}
const refused = () => new Error('The private file changed or is not a complete, singly linked owned document. Refresh Files before trying again.')
const uid = () => BigInt(process.getuid?.() ?? -1)
const version = (info: BigIntStats) => [info.dev, info.ino, info.uid, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(':')
const same = (a: {dev: bigint; ino: bigint}, b: {dev: bigint; ino: bigint}) => a.dev === b.dev && a.ino === b.ino

async function openCanonical(path: string): Promise<FileHandle> {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK
    if (process.platform === 'darwin') return open(path, flags | 0x20000000)
    let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY)
    try {
        const parts = path.split('/').filter(Boolean)
        for (const [index, part] of parts.entries()) {
            const next = await open(`/proc/self/fd/${handle.fd}/${part}`, constants.O_NOFOLLOW |
                (index === parts.length - 1 ? flags : constants.O_RDONLY | constants.O_DIRECTORY))
            await handle.close()
            handle = next
        }
        return handle
    } catch (error) { await handle.close(); throw error }
}

/** No model operation heals journals. Human Files owns that recovery and its visible conflicts. */
export async function privateFileLocation(root: string, path: string): Promise<PrivateFileLocation> {
    privateTextPath(path)
    const target = join(/* turbopackIgnore: true */ root, path)
    const directories: Directory[] = []
    let current = root
    for (const part of ['', ...path.split('/').slice(0, -1)]) {
        if (part) current = join(/* turbopackIgnore: true */ current, part)
        const info = await lstat(current, { bigint: true })
        // These are user workspace paths, never assets to trace into the standalone app.
        if (!info.isDirectory() || info.uid !== uid() || await realpath(/* turbopackIgnore: true */ current) !== current) throw refused()
        directories.push({path: current, dev: info.dev, ino: info.ino, uid: info.uid})
        const names = await readdir(/* turbopackIgnore: true */ current)
        if (names.length > 10_000 || names.some(name => /^\.rerun-(publish|rename|delete)-/.test(name))) {
            throw new Error('This folder needs recovery. Open Files before using private file tools.')
        }
    }
    const location = { directories, target }
    await assertPrivateDirectories(location)
    return location
}

export async function assertPrivateDirectories(location: PrivateFileLocation): Promise<void> {
    for (const directory of location.directories) {
        const current = await lstat(directory.path, { bigint: true })
        if (!current.isDirectory() || current.uid !== directory.uid || !same(current, directory) ||
            await realpath(/* turbopackIgnore: true */ directory.path) !== directory.path) throw refused()
    }
}

/** The path may be a pinned backup, but both names and the opened inode must agree. */
export async function readPrivateTextAt(target: string) {
    const handle = await openCanonical(target)
    try {
        const initial = await handle.stat({ bigint: true })
        if (!initial.isFile() || initial.uid !== uid() || initial.nlink !== BigInt(1) || initial.size > BigInt(PRIVATE_TEXT_BYTES)) throw refused()
        const bytes = Buffer.alloc(Number(initial.size) + 1)
        let used = 0
        while (used < bytes.length) {
            const read = await handle.read(bytes, used, bytes.length - used, used)
            if (!read.bytesRead) break
            used += read.bytesRead
        }
        const [final, named] = await Promise.all([handle.stat({bigint: true}), lstat(target, {bigint: true})])
        if (used !== Number(initial.size) || version(final) !== version(initial) || version(named) !== version(initial) || !named.isFile()) throw refused()
        const content = boundedPrivateText(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, used)))
        return {content, hash: hashText(content), identity: `${initial.dev}:${initial.ino}`, version: version(initial),
            mtime: String(initial.mtimeNs), size: used, truncated: false as const, mode: Number(initial.mode & BigInt(0o777))}
    } finally { await handle.close() }
}

export async function readPrivateSnapshot(location: PrivateFileLocation): Promise<PrivateFileSnapshot> {
    await assertPrivateDirectories(location)
    const read = await readPrivateTextAt(location.target)
    await assertPrivateDirectories(location)
    return {...location, ...read}
}

export async function assertPrivateSnapshot(snapshot: PrivateFileSnapshot): Promise<void> {
    const read = await readPrivateSnapshot(snapshot)
    if (read.version !== snapshot.version) throw refused()
}

/** Retain displaced inodes; an external writer may acquire one after any lsof check. */
export async function assertPrivateBackupBudget(location: PrivateFileLocation): Promise<void> {
    let count = 0, bytes = BigInt(0)
    for (const name of await readdir(/* turbopackIgnore: true */ dirname(/* turbopackIgnore: true */ location.target))) {
        if (!name.startsWith('.rerun-backup-')) continue
        const stat = await lstat(join(/* turbopackIgnore: true */ dirname(location.target), name), {bigint: true})
        if (++count >= 999 || !stat.isFile() || stat.uid !== uid() || (bytes += stat.size) > BigInt(50 * 1024 * 1024 - 2 * PRIVATE_TEXT_BYTES)) {
            throw new Error('Private file recovery storage is full. Review hidden backup files in Files before editing again.')
        }
    }
    await assertPrivateDirectories(location)
}
