import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { MAX_UPLOAD_FILE_BYTES } from '@rerun/contracts'
import { openWithoutLinks } from '../open-without-links.js'
import {
    FILES_IMPORT_ABORTED,
    FILES_IMPORT_OTHER_USER,
    FILES_IMPORT_OUTSIDE,
    FILES_IMPORT_UNAVAILABLE,
    FILES_IMPORT_UNCONFIRMED,
    FilesImportError,
    filesImportClash,
} from './errors.js'
import { filesImportParts, filesImportTooLarge } from './paths.js'

const STAGING_PREFIX = '.rerun-import-'
// Darwin O_NOFOLLOW_ANY. It already covers every component and must not be combined with O_NOFOLLOW.
const O_NOFOLLOW_ANY = 0x20000000

export type FilesImportPublication = { saved: true; path: string; bytes: number }

const outside = () => new FilesImportError(400, FILES_IMPORT_OUTSIDE, 'outside')
const otherUser = () => new FilesImportError(403, FILES_IMPORT_OTHER_USER, 'other_user')
const uncertain = () => new FilesImportError(500, FILES_IMPORT_UNCONFIRMED, 'unconfirmed')
const aborted = () => new FilesImportError(0, FILES_IMPORT_ABORTED, 'aborted')
const unavailable = () => new FilesImportError(400, FILES_IMPORT_UNAVAILABLE, 'unavailable')
const tooLarge = () => new FilesImportError(413, `This file is larger than the ${MAX_UPLOAD_FILE_BYTES / 1024 / 1024} MB upload limit.`, 'too_large')

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
    if (error instanceof FilesImportError) return error
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
    const info = await lstat(directory).catch(error => {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') throw outside()
        throw mapLink(error)
    })
    if (info.isSymbolicLink() || !info.isDirectory()) throw outside()
    if (!sameOwner(info.uid, uid)) throw otherUser()
    if (await realpath(directory) !== directory) throw outside()
}

async function removeCreated(created: string[]): Promise<void> {
    for (const directory of [...created].reverse()) await rmdir(directory).catch(() => {})
}

/**
 * Create-only publication into a coworker workspace (`…/workspace`).
 * link(2) does not replace an existing name, including a symlink.
 * A saved result is returned only after the linked inode matches the staged file.
 * Cancellation and an unconfirmed link are not success.
 */
export async function publishFilesImport(
    workspaceRoot: string,
    relativePath: string,
    bytes: Uint8Array,
    signal: AbortSignal,
    onProgress: (loaded: number, total: number) => void = () => {},
): Promise<FilesImportPublication> {
    if (signal.aborted) throw aborted()
    const parts = filesImportParts(relativePath)
    if (filesImportTooLarge(bytes.byteLength)) throw tooLarge()
    const uid = currentUid()
    const root = resolve(workspaceRoot)
    if (basename(root) !== 'workspace') throw unavailable()
    const created: string[] = []
    try {
        await ensureWorkspace(root, uid, signal, created)
        let parent = root
        for (const part of parts.slice(0, -1)) {
            if (signal.aborted) throw aborted()
            parent = join(parent, part)
            await ensureChild(dirname(parent), part, parent, uid, signal, created)
        }
        if (signal.aborted) throw aborted()
        await stage(parent, parts[parts.length - 1] ?? '', bytes, signal, onProgress)
        return { saved: true, path: relativePath, bytes: bytes.byteLength }
    } catch (error) {
        await removeCreated(created)
        if (error instanceof FilesImportError) throw error
        if (signal.aborted) throw aborted()
        throw mapLink(error)
    }
}

async function ensureWorkspace(root: string, uid: bigint, signal: AbortSignal, created: string[]): Promise<void> {
    if (signal.aborted) throw aborted()
    const info = await lstat(root).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw mapLink(error)
    })
    if (!info) {
        const parent = dirname(root)
        await assertRealDirectory(parent, uid)
        const pin = await pinDirectory(parent)
        try {
            if (signal.aborted) throw aborted()
            try {
                await mkdir(at(pin.pinned, 'workspace'))
                created.push(root)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw mapLink(error)
            }
        } finally {
            await pin.close()
        }
    }
    await assertRealDirectory(root, uid)
}

async function ensureChild(parent: string, name: string, child: string, uid: bigint, signal: AbortSignal, created: string[]): Promise<void> {
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
        if (signal.aborted) throw aborted()
        try {
            await mkdir(at(pin.pinned, name))
            created.push(child)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw mapLink(error)
        }
    } finally {
        await pin.close()
    }
    const madeInfo = await lstat(child).catch(error => { throw mapLink(error) })
    if (madeInfo.isSymbolicLink() || !madeInfo.isDirectory() || !sameOwner(madeInfo.uid, uid) || await realpath(child) !== child) throw outside()
}

async function stage(
    parent: string,
    name: string,
    bytes: Uint8Array,
    signal: AbortSignal,
    onProgress: (loaded: number, total: number) => void,
): Promise<void> {
    if (!name) throw outside()
    await assertRealDirectory(parent, currentUid())
    const existing = await lstat(join(parent, name)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw mapLink(error)
    })
    if (existing) throw new FilesImportError(409, filesImportClash(name), 'clash')
    const tempName = `${STAGING_PREFIX}${randomBytes(12).toString('hex')}`
    const pin = await pinDirectory(parent)
    let tempPath: string | null = null
    let handle: FileHandle | null = null
    let published = false
    try {
        if (signal.aborted) throw aborted()
        if (await lstat(at(pin.pinned, name)).then(() => true, () => false)) throw new FilesImportError(409, filesImportClash(name), 'clash')
        const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        const stagedPath = at(pin.pinned, tempName)
        handle = process.platform === 'darwin'
            ? await open(stagedPath, flags | O_NOFOLLOW_ANY, 0o644)
            : await open(stagedPath, flags | constants.O_NOFOLLOW, 0o644)
        const opened = await handle.stat({ bigint: true })
        const listed = await lstat(stagedPath, { bigint: true })
        if (opened.ino !== listed.ino || opened.dev !== listed.dev || listed.isSymbolicLink()) throw outside()
        tempPath = stagedPath
        if (signal.aborted) throw aborted()
        onProgress(0, bytes.byteLength)
        await handle.writeFile(bytes)
        await handle.sync()
        onProgress(bytes.byteLength, bytes.byteLength)
        if (signal.aborted) throw aborted()
        try {
            await link(tempPath, at(pin.pinned, name))
            published = true
            const [created, staged] = await Promise.all([
                lstat(at(pin.pinned, name), { bigint: true }),
                lstat(tempPath, { bigint: true }),
            ])
            if (created.isSymbolicLink() || staged.isSymbolicLink() || created.ino !== staged.ino || created.dev !== staged.dev) throw uncertain()
            if (signal.aborted) throw aborted()
            if (created.size !== BigInt(bytes.byteLength)) throw uncertain()
        } catch (error) {
            if (published) {
                const [created, staged] = await Promise.all([
                    lstat(at(pin.pinned, name), { bigint: true }).catch(() => null),
                    tempPath ? lstat(tempPath, { bigint: true }).catch(() => null) : null,
                ])
                if (created && staged && !created.isSymbolicLink() && created.ino === staged.ino && created.dev === staged.dev) {
                    await unlink(at(pin.pinned, name)).catch(() => {})
                }
                if (signal.aborted || (error instanceof FilesImportError && error.code === 'aborted')) throw aborted()
                if (error instanceof FilesImportError) throw error
                throw uncertain()
            }
            if (error instanceof FilesImportError) throw error
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FilesImportError(409, filesImportClash(name), 'clash')
            throw mapLink(error)
        }
    } catch (error) {
        if (error instanceof FilesImportError) throw error
        if (signal.aborted && !published) throw aborted()
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ELOOP' || code === 'ENOTDIR') throw outside()
        throw error
    } finally {
        await handle?.close().catch(() => {})
        if (tempPath) await unlink(tempPath).catch(() => {})
        await pin.close()
    }
}
