import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, link, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { openWithoutLinks } from '../open-without-links.js'
import { recordCreatedWorkspaceDirectory, removeCreatedWorkspaceDirectories, type CreatedWorkspaceDirectory } from '../created-workspace-directories.js'
import { DownloadTooLargeError } from './errors.js'
import { DOWNLOAD_LIMIT_BYTES } from './limits.js'
import { downloadPathParts } from './path.js'

const STAGING_PREFIX = '.rerun-download-'
// Darwin O_NOFOLLOW_ANY. It already covers every component and must not be combined with O_NOFOLLOW.
const O_NOFOLLOW_ANY = 0x20000000

const outside = () => new Error('That path is outside this coworker’s workspace.')
const otherUser = () => new Error('This file belongs to another user. It was left unopened.')
const clash = (name: string) => new Error(`This folder already has a file named “${name}”. The existing file was kept.`)
const uncertain = () => new Error('The download result could not be confirmed. Check Files before retrying.')
const unavailable = () => new Error('Download publication is only available on this Mac.')

function sameOwner(statUid: number, expected: bigint): boolean {
    return BigInt(statUid) === expected
}

function currentUid(): bigint {
    if (typeof process.getuid !== 'function') throw unavailable()
    return BigInt(process.getuid())
}

function at(pinned: string, name: string): string {
    return process.platform === 'darwin' ? join(pinned, name) : `${pinned}/${name}`
}

function mapLink(error: unknown): unknown {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'ENOTDIR') return outside()
    return error
}

async function pinDirectory(directory: string): Promise<{ pinned: string; close: () => Promise<void> }> {
    let handle: FileHandle
    try {
        handle = await openWithoutLinks(directory, true)
    } catch (error) {
        if (error instanceof Error && error.message === 'Unsupported filesystem') throw unavailable()
        throw mapLink(error)
    }
    try {
        const info = await handle.stat({ bigint: true })
        if (!info.isDirectory() || info.uid !== currentUid()) throw info.isDirectory() ? otherUser() : outside()
        const pinned = process.platform === 'darwin' ? `/.vol/${info.dev}/${info.ino}` : `/proc/self/fd/${handle.fd}`
        return { pinned, close: () => handle.close() }
    } catch (error) {
        await handle.close()
        throw error
    }
}

async function assertRealDirectory(directory: string, uid: bigint): Promise<void> {
    const info = await lstat(directory).catch(error => { throw mapLink(error) })
    if (info.isSymbolicLink() || !info.isDirectory()) throw outside()
    if (!sameOwner(info.uid, uid)) throw otherUser()
    if (await realpath(directory) !== directory) throw outside()
}

/**
 * Create-only publication into a coworker workspace (`…/workspace`).
 * link(2) does not replace an existing name, including a symlink. Staging names are `.rerun-download-*`.
 */
export async function publishDownload(workspaceRoot: string, relativePath: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const parts = downloadPathParts(relativePath)
    if (bytes.byteLength > DOWNLOAD_LIMIT_BYTES) throw new DownloadTooLargeError(bytes.byteLength)
    const uid = currentUid()
    const root = resolve(workspaceRoot)
    if (basename(root) !== 'workspace') throw unavailable()
    const created: CreatedWorkspaceDirectory[] = []
    try {
        await ensureWorkspace(root, uid, signal, created)
        let parent = root
        for (const part of parts.slice(0, -1)) {
            signal.throwIfAborted()
            parent = join(parent, part)
            await ensureChild(dirname(parent), part, parent, uid, signal, created)
        }
        signal.throwIfAborted()
        await stage(parent, parts[parts.length - 1] ?? '', bytes, signal)
    } catch (error) {
        await removeCreatedWorkspaceDirectories(created)
        throw error
    }
}

async function ensureWorkspace(root: string, uid: bigint, signal: AbortSignal, created: CreatedWorkspaceDirectory[]): Promise<void> {
    signal.throwIfAborted()
    const info = await lstat(root).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw mapLink(error)
    })
    if (!info) {
        const parent = dirname(root)
        await assertRealDirectory(parent, uid)
        const pin = await pinDirectory(parent)
        try {
            signal.throwIfAborted()
            try {
                const target = at(pin.pinned, 'workspace')
                await mkdir(target)
                created.push(await recordCreatedWorkspaceDirectory(root, target))
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw mapLink(error)
            }
        } finally {
            await pin.close()
        }
    }
    await assertRealDirectory(root, uid)
    if (created.at(-1)?.path === root) {
        const again = await lstat(root)
        if (again.isSymbolicLink() || !again.isDirectory()) throw outside()
    }
}

async function ensureChild(parent: string, name: string, child: string, uid: bigint, signal: AbortSignal, created: CreatedWorkspaceDirectory[]): Promise<void> {
    const info = await lstat(child).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw mapLink(error)
    })
    if (info?.isSymbolicLink()) throw outside()
    if (info && !info.isDirectory()) throw outside()
    if (info) {
        if (!sameOwner(info.uid, uid)) throw otherUser()
        if (await realpath(child) !== child) throw outside()
        return
    }
    await assertRealDirectory(parent, uid)
    const pin = await pinDirectory(parent)
    try {
        signal.throwIfAborted()
        try {
            const target = at(pin.pinned, name)
            await mkdir(target)
            created.push(await recordCreatedWorkspaceDirectory(child, target))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw mapLink(error)
        }
    } finally {
        await pin.close()
    }
    const made = await lstat(child).catch(error => { throw mapLink(error) })
    if (made.isSymbolicLink() || !made.isDirectory() || !sameOwner(made.uid, uid) || await realpath(child) !== child) throw outside()
}

async function stage(parent: string, name: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    if (!name) throw outside()
    await assertRealDirectory(parent, currentUid())
    const existing = await lstat(join(parent, name)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw mapLink(error)
    })
    if (existing) throw clash(name)
    const tempName = `${STAGING_PREFIX}${randomBytes(12).toString('hex')}`
    const pin = await pinDirectory(parent)
    let tempPath: string | null = null
    try {
        signal.throwIfAborted()
        if (await lstat(at(pin.pinned, name)).then(() => true, () => false)) throw clash(name)
        const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        const stagedPath = at(pin.pinned, tempName)
        const handle = process.platform === 'darwin'
            ? await open(stagedPath, flags | O_NOFOLLOW_ANY, 0o644)
            : await open(stagedPath, flags | constants.O_NOFOLLOW, 0o644)
        tempPath = stagedPath
        let published = false
        try {
            const opened = await handle.stat({ bigint: true })
            const listed = await lstat(tempPath, { bigint: true })
            if (opened.ino !== listed.ino || opened.dev !== listed.dev || listed.isSymbolicLink()) throw outside()
            signal.throwIfAborted()
            await handle.writeFile(bytes)
            await handle.sync()
            signal.throwIfAborted()
            try {
                await link(tempPath, at(pin.pinned, name))
                published = true
                const [created, staged] = await Promise.all([
                    lstat(at(pin.pinned, name), { bigint: true }),
                    lstat(tempPath, { bigint: true }),
                ])
                if (created.isSymbolicLink() || staged.isSymbolicLink() || created.ino !== staged.ino || created.dev !== staged.dev) {
                    throw uncertain()
                }
            } catch (error) {
                if (published) {
                    const [created, staged] = await Promise.all([
                        lstat(at(pin.pinned, name), { bigint: true }).catch(() => null),
                        tempPath ? lstat(tempPath, { bigint: true }).catch(() => null) : null,
                    ])
                    if (created && staged && created.ino === staged.ino && created.dev === staged.dev) {
                        await unlink(at(pin.pinned, name)).catch(() => {})
                    }
                    throw uncertain()
                }
                const code = (error as NodeJS.ErrnoException).code
                if (code === 'EEXIST') throw clash(name)
                throw mapLink(error)
            }
        } finally {
            await handle.close()
        }
    } catch (error) {
        throw error instanceof Error && (error as NodeJS.ErrnoException).code && ['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? outside() : error
    } finally {
        if (tempPath) await unlink(tempPath).catch(() => {})
        await pin.close()
    }
}
