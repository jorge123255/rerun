import 'server-only'
import { constants } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { findDesktopAgent } from './store'
import { withRosterWrite } from './roster-writes'
import { assertCoworkerNotDeleting } from './coworker-delete'
import {
    DESKTOP_IMAGE_MAX_BYTES,
    DesktopImageBytesError,
    desktopRasterKind,
    inspectDesktopImageBytes,
    type DesktopImageContentType,
} from './image-bytes'
import {
    desktopImageKindForName,
    desktopImageMediaType,
    desktopImageSnapshotSchema,
    type DesktopImageKind,
    type DesktopImageMediaType,
    type DesktopImageSnapshot,
} from '../composer-image'

const SNAPSHOT_DIR = 'chat-images'
const SAFE_ENGINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const inside = (root: string, target: string) => {
    const rel = relative(root, target)
    return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')

async function agentEngineDirs(runtime: DesktopRuntime, agentId: string): Promise<{ agentDir: string; workspace: string; images: string }> {
    const coworker = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
    if (!coworker) throw new DesktopHttpError(404, 'Coworker not found')
    if (!SAFE_ENGINE_ID.test(coworker.engineAgentId)) throw new DesktopHttpError(400, 'This coworker has no readable workspace.')
    const agentDir = resolve(await realpath(runtime.dataRoot), 'workspaces', '1', 'engine', 'agents', coworker.engineAgentId)
    return { agentDir, workspace: join(agentDir, 'workspace'), images: join(agentDir, SNAPSHOT_DIR) }
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

async function ensureRealDirectory(path: string, base: string): Promise<void> {
    const info = await lstat(path).catch(error => { if (missing(error)) return null; throw error })
    if (info) {
        if (!info.isDirectory() || await realpath(path) !== path) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
        return
    }
    const parent = dirname(path)
    if (parent === path || !inside(base, path)) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    await ensureRealDirectory(parent, base)
    await mkdir(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    const created = await lstat(path)
    if (!created.isDirectory() || await realpath(path) !== path) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
}

async function writeCreateOnly(directory: string, name: string, bytes: Uint8Array): Promise<void> {
    const dir = await openResolved(directory, true)
    try {
        const pinned = await pinnedDirectory(dir)
        if (await lstat(join(pinned, name)).then(() => true, () => false)) {
            throw new DesktopHttpError(409, `This folder already has a file named “${name}”. The existing file was kept; rename yours and import it again.`)
        }
        const tempName = `.rerun-import-${randomBytes(12).toString('hex')}`
        const tempPath = join(pinned, tempName)
        const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        const handle = process.platform === 'darwin'
            ? await open(join(directory, tempName), flags | 0x20000000, 0o644)
            : await open(`${pinned}/${tempName}`, flags | constants.O_NOFOLLOW, 0o644)
        try {
            await handle.writeFile(bytes)
            await handle.sync()
        } finally {
            await handle.close()
        }
        try {
            await link(tempPath, join(pinned, name))
        } finally {
            await unlink(tempPath).catch(() => {})
        }
    } finally {
        await dir.close()
    }
}

function imageNameProblem(name: string): string | null {
    if (!name || new TextEncoder().encode(name).length > 255 || name.includes('/') || name.includes('\\') || name.includes('\0') || name.startsWith('.') || /\p{Cc}/u.test(name)) {
        return 'That file name can’t be imported.'
    }
    if (!desktopImageKindForName(name)) return 'Only .png, .jpg, and .webp images can be attached.'
    return null
}

/** Structural pass (image-bytes) plus a real pixel decode through sharp, so corrupt scan data
 * that headers alone would miss is refused here rather than inside the provider turn. */
async function inspectComposerImage(name: string, bytes: Uint8Array): Promise<{ kind: DesktopImageKind; width: number; height: number; contentType: DesktopImageContentType }> {
    const problem = imageNameProblem(name)
    if (problem) throw new DesktopHttpError(415, problem)
    const kind = desktopImageKindForName(name)!
    const raster = desktopRasterKind(name)
    if (!raster) throw new DesktopHttpError(415, 'Only .png, .jpg, and .webp images can be attached.')
    let inspected: { width: number; height: number; contentType: DesktopImageContentType }
    try {
        inspected = inspectDesktopImageBytes(raster, bytes)
    } catch (error) {
        if (error instanceof DesktopImageBytesError && error.reason === 'animation') throw new DesktopHttpError(415, 'Animated images can’t be attached. Choose a static image.')
        if (error instanceof DesktopImageBytesError && error.reason === 'dimensions') throw new DesktopHttpError(413, 'This image is too large to attach.')
        throw new DesktopHttpError(415, 'This file is not a supported image.')
    }
    try {
        const meta = await sharp(bytes, { animated: false }).metadata()
        if ((meta.pages ?? 1) > 1) throw new DesktopHttpError(415, 'Animated images can’t be attached. Choose a static image.')
        await sharp(bytes, { animated: false }).stats()
    } catch (error) {
        if (error instanceof DesktopHttpError) throw error
        throw new DesktopHttpError(415, 'This image is damaged and can’t be attached.')
    }
    return { kind, width: inspected.width, height: inspected.height, contentType: inspected.contentType }
}

export function desktopImageSnapshotId(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
}

function snapshotExtension(mediaType: DesktopImageMediaType): string {
    return mediaType === 'image/png' ? 'png' : mediaType === 'image/jpeg' ? 'jpg' : 'webp'
}

async function storeSnapshot(imagesDir: string, snapshot: { sha256: string; mediaType: DesktopImageMediaType }, bytes: Uint8Array): Promise<void> {
    const name = `${snapshot.sha256}.${snapshotExtension(snapshot.mediaType)}`
    const existing = await lstat(join(imagesDir, name)).catch(error => { if (missing(error)) return null; throw error })
    if (existing) {
        if (!existing.isFile() || existing.size !== bytes.byteLength) throw new DesktopHttpError(409, 'The image snapshot store changed. Try again.')
        return
    }
    await writeCreateOnly(imagesDir, name, bytes)
}

/**
 * Imports one PNG/JPEG/WebP into the selected coworker's visible workspace AND pins its bytes
 * in the private content-addressed snapshot store. The visible copy is create-only like text
 * imports; the snapshot is what a later send resolves, so replacing the Files copy can never
 * silently change what the model sees.
 */
export async function importDesktopComposerImage(runtime: DesktopRuntime, agentId: string, folder: string, name: string, bytes: Uint8Array): Promise<{ path: string; name: string; image: DesktopImageSnapshot }> {
    return withRosterWrite(async () => {
        await assertCoworkerNotDeleting(await openDesktopDatabase(runtime.dataRoot), agentId)
        if (bytes.byteLength < 1 || bytes.byteLength > DESKTOP_IMAGE_MAX_BYTES) throw new DesktopHttpError(413, 'Images can be up to 8 MB.')
        const inspected = await inspectComposerImage(name, bytes)
        const { agentDir, workspace, images } = await agentEngineDirs(runtime, agentId)
        const base = await realpath(runtime.dataRoot)
        await ensureRealDirectory(workspace, base)
        await ensureRealDirectory(images, base)
        const rel = folder.split('/').filter(part => part && part !== '.').join('/')
        if (isAbsolute(folder) || folder.includes('\0') || rel.split('/').includes('..')) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
        const folderTarget = rel ? join(workspace, rel) : workspace
        const folderReal = await realpath(folderTarget).catch(error => { if (missing(error)) return null; throw error })
        if (!folderReal || !inside(workspace, folderReal)) throw new DesktopHttpError(404, 'Folder not found')
        const info = await lstat(folderReal)
        if (!info.isDirectory()) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace or is not a folder.')
        const path = rel ? `${rel}/${name}` : name
        await writeCreateOnly(folderReal, name, bytes)
        const sha256 = desktopImageSnapshotId(bytes)
        const snapshot = desktopImageSnapshotSchema.parse({
            sha256, name, path,
            mediaType: desktopImageMediaType(inspected.kind),
            width: inspected.width, height: inspected.height, byteLength: bytes.byteLength,
        })
        await storeSnapshot(images, snapshot, bytes)
        return { path, name, image: snapshot }
    })
}

const SNAPSHOT_NAME = /^([0-9a-f]{64})\.(png|jpe?g|webp)$/

/** Reads one pinned snapshot by content hash and proves the bytes still match it, so a send,
 * retry, queued flush, or regeneration can never silently pick up replacement bytes. */
export async function readDesktopImageSnapshot(runtime: DesktopRuntime, agentId: string, image: { sha256: string; mediaType: DesktopImageMediaType }): Promise<{ bytes: Uint8Array; byteLength: number }> {
    if (!/^[0-9a-f]{64}$/.test(image.sha256)) throw new DesktopHttpError(400, 'Choose a valid image attachment.')
    const { images } = await agentEngineDirs(runtime, agentId)
    const name = `${image.sha256}.${snapshotExtension(image.mediaType)}`
    const target = join(images, name)
    const info = await lstat(target).catch(error => { if (missing(error)) return null; throw error })
    if (!info) throw new DesktopHttpError(404, 'This image attachment is no longer available. Attach it again.')
    if (!info.isFile() || info.size < 1 || info.size > DESKTOP_IMAGE_MAX_BYTES) throw new DesktopHttpError(415, 'This image attachment is damaged.')
    const bytes = new Uint8Array(await (await open(target, constants.O_RDONLY)).then(async handle => {
        try {
            const buffer = Buffer.alloc(info.size)
            let got = 0
            while (got < buffer.length) {
                const read = await handle.read(buffer, got, buffer.length - got, got)
                if (!read.bytesRead) break
                got += read.bytesRead
            }
            return buffer.subarray(0, got)
        } finally {
            await handle.close()
        }
    }))
    if (bytes.byteLength !== Number(info.size) || desktopImageSnapshotId(bytes) !== image.sha256) {
        throw new DesktopHttpError(409, 'This image attachment changed on disk. Attach it again.')
    }
    return { bytes, byteLength: bytes.byteLength }
}

export async function readDesktopImageSnapshots(runtime: DesktopRuntime, agentId: string, images: readonly { sha256: string; mediaType: DesktopImageMediaType }[]): Promise<Map<string, Uint8Array>> {
    const resolved = new Map<string, Uint8Array>()
    for (const image of images) {
        const snapshot = await readDesktopImageSnapshot(runtime, agentId, image)
        resolved.set(image.sha256, snapshot.bytes)
    }
    return resolved
}

/** Removes snapshot files no draft, queue item, or pending send still references. Sent messages
 * carry the resolved bytes themselves, so history never depends on this store. Returns the
 * number of deleted snapshots. */
export async function pruneDesktopImageSnapshots(runtime: DesktopRuntime, agentId: string, keep: ReadonlySet<string>): Promise<number> {
    const { images } = await agentEngineDirs(runtime, agentId)
    const entries = await readdir(images).catch(error => { if (missing(error)) return []; throw error })
    let removedCount = 0
    for (const entry of entries) {
        const match = SNAPSHOT_NAME.exec(entry)
        if (!match || keep.has(match[1]!)) continue
        const removed = await unlink(join(images, entry)).then(() => true, () => false)
        if (removed) removedCount++
    }
    return removedCount
}
