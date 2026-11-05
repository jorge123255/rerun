import 'server-only'
import { constants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DesktopHttpError } from './auth'
import { DESKTOP_IMAGE_MAX_BYTES, desktopRasterKind, type DesktopImageContentType } from './image-bytes'
import { DesktopPreviewImageError, inspectDesktopPreviewImageBytes } from './animated-image'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { findDesktopAgent } from './store'
import { withRosterWrite } from './roster-writes'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { readCoworkerImage } from './coworker-files'

export type CoworkerPreviewImageFolder = {
    recoverInterruptedEdits(directory: string, workspaceRoot: string): Promise<unknown>
    claimed(directory: string, name: string): boolean
}

type BoundaryHost = typeof globalThis & Record<symbol, CoworkerPreviewImageFolder | undefined>
// Called during module binding: don't depend on a const initialized after a cyclic import.
function boundaryKey() { return Symbol.for('rerun.desktop.previewImageFolder') }

function boundaryHost(): BoundaryHost {
    return globalThis as BoundaryHost
}

/** Install the shared recovery and claim closures. Root binds the real coworker-files functions.
 * An unbound reader keeps the static image reader, so PNG preview still works before that bind. */
export function bindCoworkerPreviewImageFolder(boundary: CoworkerPreviewImageFolder): () => void {
    const host = boundaryHost()
    const previous = host[boundaryKey()]
    host[boundaryKey()] = boundary
    let restored = false
    return () => {
        if (restored) return
        restored = true
        if (previous) host[boundaryKey()] = previous
        else delete host[boundaryKey()]
    }
}

export type CoworkerPreviewImage = {
    path: string
    name: string
    bytes: Uint8Array
    contentType: DesktopImageContentType
    identity: string
    width: number
    height: number
    frames: number
    animated: boolean
}

const IMAGE_IDENTITY = /^\d{1,24}:\d{1,24}$/
const MAX_IMAGE_DEPTH = 64
const SAFE_ENGINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const IMAGE_FILE_OPEN = constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW)
const EDIT_PREFIX = '.rerun-edit-'
const BACKUP_PREFIX = '.rerun-backup-'
const PUBLISH_PREFIX = '.rerun-publish-'
const RENAME_PREFIX = '.rerun-rename-'
const DELETE_PREFIX = '.rerun-delete-'
const reservedName = (name: string) => name.startsWith(EDIT_PREFIX) || name.startsWith(BACKUP_PREFIX) || name.startsWith(PUBLISH_PREFIX) || name.startsWith(RENAME_PREFIX) || name.startsWith(DELETE_PREFIX) || name.startsWith('.rerun-import-') || name.startsWith('.rerun-retire-')
const simpleName = (name: string) => name.length > 0 && !name.includes('/') && !name.includes('\\') && !name.includes('\0') && name !== '.' && name !== '..'

const inside = (root: string, target: string) => {
    const rel = relative(root, target)
    return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')

type FileIdentity = { dev: bigint; ino: bigint }
const sameFile = (left: FileIdentity | null, right: FileIdentity | null) => !!left && !!right && left.dev === right.dev && left.ino === right.ino

function assertPreviewOpen(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DesktopHttpError(499, 'Image preview was closed.')
}

/** Read one existing PNG, JPEG, WebP, or GIF for the Files image preview.
 * The returned bytes are the file itself. Animated GIF and WebP are not flattened.
 * Until root binds the folder closures, this falls back to the static reader. */
export async function readCoworkerPreviewImage(runtime: DesktopRuntime, agentId: string, path: string, identity?: string, signal?: AbortSignal): Promise<CoworkerPreviewImage> {
    assertPreviewOpen(signal)
    const boundary = boundaryHost()[boundaryKey()]
    if (!boundary) {
        const image = await readCoworkerImage(runtime, agentId, path, identity)
        return { ...image, frames: 1, animated: false }
    }
    return withRosterWrite(async () => {
        assertPreviewOpen(signal)
        await assertCoworkerNotDeleting(await openDesktopDatabase(runtime.dataRoot), agentId)
        return readPreviewImage(runtime, agentId, path, identity, boundary, signal)
    })
}

async function readPreviewImage(runtime: DesktopRuntime, agentId: string, path: string, identity: string | undefined, boundary: CoworkerPreviewImageFolder, signal?: AbortSignal): Promise<CoworkerPreviewImage> {
    assertPreviewOpen(signal)
    if (identity !== undefined && !IMAGE_IDENTITY.test(identity)) throw new DesktopHttpError(400, 'Send the image to preview.')
    const rel = lexicalRelative(path)
    if (!rel) throw new DesktopHttpError(400, 'Choose an image to preview.')
    const parts = rel.split('/')
    if (parts.length > MAX_IMAGE_DEPTH) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const name = parts[parts.length - 1]!
    if (parts.some(part => !simpleName(part) || reservedName(part))) throw new DesktopHttpError(400, 'That name can’t be previewed.')
    const kind = desktopRasterKind(name)
    if (!kind) throw new DesktopHttpError(415, 'Only PNG, JPEG, WebP, and GIF files can be previewed.')
    const workspace = await coworkerWorkspace(runtime, agentId)
    const root = await containedPath(workspace, '')
    if (!root.root) throw new DesktopHttpError(404, `“${name}” was not found.`)
    const uid = currentUid()
    const parentRel = parts.slice(0, -1).join('/')
    const parentPath = join(/* turbopackIgnore: true */ root.root, parentRel)
    await assertImageDirectories(root.root, parts.slice(0, -1), uid, name)
    assertPreviewOpen(signal)
    await boundary.recoverInterruptedEdits(parentPath, root.root)
    assertPreviewOpen(signal)
    const parents = await assertImageDirectories(root.root, parts.slice(0, -1), uid, name)
    const located = join(/* turbopackIgnore: true */ parentPath, name)
    const listed = await fileStat(located)
    if (!listed) throw new DesktopHttpError(404, `“${name}” was not found.`)
    if (listed.isSymbolicLink()) throw new DesktopHttpError(400, 'Choose an image file, not a symlink.')
    if (!listed.isFile()) throw new DesktopHttpError(400, 'That path is not a file.')
    if (listed.uid !== uid) throw new DesktopHttpError(403, 'This file belongs to another user. It was left unopened.')
    if (listed.nlink !== BigInt(1)) throw new DesktopHttpError(400, 'This image has another link. It was left unopened.')
    if (identity && `${listed.dev}:${listed.ino}` !== identity) throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
    if (listed.size === BigInt(0)) throw new DesktopHttpError(415, 'This image is damaged and can’t be previewed.')
    if (listed.size > BigInt(DESKTOP_IMAGE_MAX_BYTES)) throw new DesktopHttpError(413, 'Images can be up to 8 MB.')
    if (boundary.claimed(parentPath, name)) throw new DesktopHttpError(409, 'This file is being saved. Try the preview again once that finishes.')
    const canonical = await realpath(/* turbopackIgnore: true */ located).catch(() => null)
    if (canonical !== located || !inside(root.root, canonical)) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    assertPreviewOpen(signal)
    const dir = await openResolved(parentPath, true)
    try {
        const pinned = await pinnedDirectory(dir)
        const openedParent = await dir.stat({ bigint: true })
        if (!sameFile(openedParent, parents[parents.length - 1] ?? null) || openedParent.uid !== uid) {
            throw new DesktopHttpError(400, 'That folder changed. The image was left unopened.')
        }
        const handle = await open(join(pinned, name), IMAGE_FILE_OPEN).catch(error => {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ELOOP' || code === 'ENOTDIR') throw new DesktopHttpError(400, 'Choose an image file, not a symlink.')
            if (code === 'ENOENT') throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
            throw error
        })
        try {
            const opened = await handle.stat({ bigint: true })
            if (!sameFile(opened, listed) || opened.isSymbolicLink() || !opened.isFile() || opened.uid !== uid || opened.nlink !== BigInt(1)) {
                throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
            }
            const length = Number(opened.size)
            if (!Number.isSafeInteger(length) || length < 1 || length > DESKTOP_IMAGE_MAX_BYTES) throw new DesktopHttpError(413, 'Images can be up to 8 MB.')
            assertPreviewOpen(signal)
            const buffer = Buffer.alloc(length)
            let got = 0
            while (got < length) {
                assertPreviewOpen(signal)
                const read = await handle.read(buffer, got, length - got, got)
                if (!read.bytesRead) break
                got += read.bytesRead
            }
            const after = await handle.stat({ bigint: true })
            const still = await fileStat(join(pinned, name))
            if (got !== length || !sameFile(after, listed) || after.size !== opened.size || !sameFile(still, listed)) {
                throw new DesktopHttpError(409, 'This image changed while it was being read.')
            }
            for (const parent of parents) {
                const now = await fileStat(parent.path)
                if (!now || now.isSymbolicLink() || !now.isDirectory() || !sameFile(now, parent) || now.uid !== uid) {
                    throw new DesktopHttpError(400, 'That folder changed. The image was left unopened.')
                }
            }
            assertPreviewOpen(signal)
            const fileBytes = new Uint8Array(buffer.subarray(0, got))
            let inspected: ReturnType<typeof inspectDesktopPreviewImageBytes>
            try { inspected = inspectDesktopPreviewImageBytes(kind, fileBytes) }
            catch (error) { throw previewFailure(error) }
            return {
                path: rel, name, bytes: fileBytes, contentType: inspected.contentType, identity: `${listed.dev}:${listed.ino}`,
                width: inspected.width, height: inspected.height, frames: inspected.frames, animated: inspected.animated,
            }
        } finally { await handle.close() }
    } finally { await dir.close() }
}

function previewFailure(error: unknown): never {
    if (error instanceof DesktopPreviewImageError && error.reason === 'dimensions') throw new DesktopHttpError(413, 'This image is too large to preview.')
    if (error instanceof DesktopPreviewImageError && error.reason === 'aggregate') throw new DesktopHttpError(413, 'This animation is too large to preview.')
    if (error instanceof DesktopPreviewImageError && error.reason === 'frames') throw new DesktopHttpError(413, 'This animation has too many frames to preview.')
    if (error instanceof DesktopPreviewImageError && error.reason === 'mismatch') throw new DesktopHttpError(415, 'This file is not a supported image.')
    if (error instanceof DesktopPreviewImageError && error.reason === 'animation') throw new DesktopHttpError(415, 'Animated PNG can’t be previewed.')
    throw new DesktopHttpError(415, 'This image is damaged and can’t be previewed.')
}

async function coworkerWorkspace(runtime: DesktopRuntime, agentId: string): Promise<string> {
    const coworker = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
    if (!coworker) throw new DesktopHttpError(404, 'Coworker not found')
    if (!SAFE_ENGINE_ID.test(coworker.engineAgentId)) throw new DesktopHttpError(400, 'This coworker has no readable workspace.')
    return resolve(await realpath(runtime.dataRoot), 'workspaces', '1', 'engine', 'agents', coworker.engineAgentId, 'workspace')
}

async function containedPath(workspace: string, path: string): Promise<{ root: string | null; target: string | null; rel: string }> {
    const rel = path.split('/').filter(part => part && part !== '.').join('/')
    if (isAbsolute(path) || path.includes('\0') || rel.split('/').includes('..')) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const info = await lstat(workspace).catch(error => { if (missing(error)) return null; throw error })
    if (!info) return { root: null, target: null, rel }
    if (!info.isDirectory()) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const root = await realpath(workspace)
    if (root !== workspace) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const target = await realpath(join(root, rel)).catch(error => { if (missing(error)) return null; throw error })
    if (target && !inside(root, target)) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    return { root, target, rel }
}

async function openResolved(target: string, directory = false): Promise<FileHandle> {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0)
    try {
        if (process.platform === 'darwin') return await open(target, flags | 0x20000000)
        let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY)
        try {
            const parts = target.split('/').filter(Boolean)
            for (const [i, part] of parts.entries()) {
                const next = await open(`/proc/self/fd/${handle.fd}/${part}`,
                    constants.O_NOFOLLOW | (i === parts.length - 1 ? flags : constants.O_RDONLY | constants.O_DIRECTORY))
                await handle.close()
                handle = next
            }
            return handle
        } catch (error) {
            await handle.close()
            throw error
        }
    } catch (error) {
        if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace or is not a folder.')
        }
        throw error
    }
}

async function pinnedDirectory(handle: FileHandle): Promise<string> {
    if (process.platform !== 'darwin') return `/proc/self/fd/${handle.fd}`
    const info = await handle.stat({ bigint: true })
    return `/.vol/${info.dev}/${info.ino}`
}

function lexicalRelative(path: string): string {
    const rel = path.split('/').filter(part => part && part !== '.').join('/')
    if (isAbsolute(path) || path.includes('\0') || rel.split('/').includes('..')) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    return rel
}

function currentUid(): bigint {
    if (typeof process.getuid !== 'function') throw new DesktopHttpError(400, 'Image preview is only available on this Mac.')
    return BigInt(process.getuid())
}

async function assertImageDirectories(root: string, directories: string[], uid: bigint, fileName: string): Promise<Array<FileIdentity & { path: string }>> {
    const parents: Array<FileIdentity & { path: string }> = []
    let directory = root
    const rootInfo = await fileStat(directory)
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    if (rootInfo.uid !== uid) throw new DesktopHttpError(403, 'This file belongs to another user. It was left unopened.')
    parents.push({ path: directory, dev: rootInfo.dev, ino: rootInfo.ino })
    for (const part of directories) {
        directory = join(/* turbopackIgnore: true */ directory, part)
        const info = await fileStat(directory)
        if (!info) throw new DesktopHttpError(404, `“${fileName}” was not found.`)
        if (info.isSymbolicLink()) throw new DesktopHttpError(400, 'Choose an image file, not a symlink.')
        if (!info.isDirectory()) throw new DesktopHttpError(400, 'That path is not a folder.')
        if (info.uid !== uid) throw new DesktopHttpError(403, 'This file belongs to another user. It was left unopened.')
        parents.push({ path: directory, dev: info.dev, ino: info.ino })
    }
    return parents
}

async function fileStat(path: string) {
    try { return await lstat(path, { bigint: true }) }
    catch (error) { if (missing(error)) return null; throw error }
}
