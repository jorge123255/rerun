import 'server-only'
import { constants, type BigIntStats } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, opendir, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { findDesktopAgent } from './store'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { importCoworkerRasterFile } from './coworker-files'
import { DESKTOP_IMAGE_MAX_BYTES, DESKTOP_IMAGE_MAX_PIXELS, DesktopImageBytesError, desktopRasterKind, inspectDesktopImageBytes } from './image-bytes'
import {
    DESKTOP_IMAGE_ATTACHMENT_MAX_FILES, DESKTOP_IMAGE_ATTACHMENT_TOTAL_MAX_BYTES,
    desktopImageKindForName, desktopImageMediaType, desktopImageSnapshotSchema,
    type DesktopImageMediaType, type DesktopImageSnapshot,
} from '../composer-image'

const SAFE_ENGINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// There is deliberately no age-based deletion: a saved draft can be old and still live.
// Until reference-aware collection exists, deletion of the coworker retires its store.
export const DESKTOP_IMAGE_STORE_MAX_BYTES = 256 * 1024 * 1024
export const DESKTOP_IMAGE_STORE_MAX_FILES = 512
const pathAt = (parent: string, name: string) => join(/* turbopackIgnore: true */ parent, name)
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')
const changed = () => new DesktopHttpError(409, 'This image attachment changed on disk. Attach it again.')
const unavailable = () => new DesktopHttpError(404, 'This image attachment is no longer available. Attach it again.')
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
const sameVersion = (a: BigIntStats, b: BigIntStats) => same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const checkSignal = (signal?: AbortSignal) => { if (signal?.aborted) throw new DesktopHttpError(499, 'The image import was cancelled.') }

function uid(): bigint {
    if (typeof process.getuid !== 'function') throw new DesktopHttpError(400, 'Image attachments are only available on this Mac.')
    return BigInt(process.getuid())
}

async function stat(path: string): Promise<BigIntStats | null> {
    try { return await lstat(/* turbopackIgnore: true */ path, { bigint: true }) }
    catch (error) { if (missing(error)) return null; throw error }
}

/** O_NONBLOCK keeps a swapped FIFO from hanging. Refuse symlinks in every component. */
async function openResolved(target: string, directory = false): Promise<FileHandle> {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0)
    try {
        if (process.platform === 'darwin') return await open(/* turbopackIgnore: true */ target, flags | 0x20000000)
        let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY)
        try {
            const parts = target.split('/').filter(Boolean)
            for (const [i, part] of parts.entries()) {
                const next = await open(`/proc/self/fd/${handle.fd}/${part}`, constants.O_NOFOLLOW | (i === parts.length - 1 ? flags : constants.O_RDONLY | constants.O_DIRECTORY))
                await handle.close()
                handle = next
            }
            return handle
        } catch (error) { await handle.close(); throw error }
    } catch (error) {
        if (missing(error)) throw unavailable()
        if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw changed()
        throw error
    }
}

async function pinnedDirectory(handle: FileHandle): Promise<string> {
    if (process.platform !== 'darwin') return `/proc/self/fd/${handle.fd}`
    const info = await handle.stat({ bigint: true })
    return `/.vol/${info.dev}/${info.ino}`
}

type Store = { handle: FileHandle; pinned: string; owner: bigint; assertCurrent: () => Promise<void> }

/** Pin each owned ancestor, creating only through its descriptor. Canonical path identities
 * are checked again around every read/publication, including ordinary-directory swaps. */
async function withStore<T>(runtime: DesktopRuntime, agentId: string, create: boolean, action: (store: Store) => Promise<T>): Promise<T> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await assertCoworkerNotDeleting(db, agentId)
    const coworker = await findDesktopAgent(db, agentId)
    if (!coworker) throw new DesktopHttpError(404, 'Coworker not found')
    if (!SAFE_ENGINE_ID.test(coworker.engineAgentId)) throw new DesktopHttpError(400, 'This coworker has no readable workspace.')
    const base = resolve(/* turbopackIgnore: true */ await realpath(/* turbopackIgnore: true */ runtime.dataRoot))
    const owner = uid()
    let target = base
    let handle = await openResolved(base, true)
    const parents: { path: string; info: BigIntStats }[] = []
    const remember = async (path: string, current: FileHandle) => {
        const opened = await current.stat({ bigint: true })
        const listed = await stat(path)
        if (!listed?.isDirectory() || listed.isSymbolicLink() || opened.uid !== owner || listed.uid !== owner || !same(opened, listed)) throw changed()
        parents.push({ path, info: opened })
    }
    const assertCurrent = async () => {
        for (const parent of parents) {
            const current = await stat(parent.path)
            if (!current?.isDirectory() || current.isSymbolicLink() || current.uid !== owner || !same(current, parent.info)) throw changed()
        }
        await assertCoworkerNotDeleting(db, agentId)
        if ((await findDesktopAgent(db, agentId))?.engineAgentId !== coworker.engineAgentId) throw changed()
    }
    try {
        await remember(base, handle)
        for (const name of ['workspaces', '1', 'engine', 'agents', coworker.engineAgentId, 'chat-images']) {
            await assertCurrent()
            const pinnedChild = pathAt(await pinnedDirectory(handle), name)
            let childInfo = await stat(pinnedChild)
            if (!childInfo && create) {
                await mkdir(/* turbopackIgnore: true */ pinnedChild, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
                childInfo = await stat(pinnedChild)
            }
            if (!childInfo) throw unavailable()
            if (!childInfo.isDirectory() || childInfo.isSymbolicLink() || childInfo.uid !== owner) throw changed()
            target = pathAt(target, name)
            const next = await openResolved(target, true)
            try {
                if (!same(await next.stat({ bigint: true }), childInfo)) throw changed()
                await remember(target, next)
            } catch (error) { await next.close(); throw error }
            await handle.close()
            handle = next
        }
        await assertCurrent()
        return await action({ handle, pinned: await pinnedDirectory(handle), owner, assertCurrent })
    } finally { await handle.close() }
}

function imageNameProblem(name: string): string | null {
    if (!name || new TextEncoder().encode(name).length > 255 || name.includes('/') || name.includes('\\') || name.includes('\0') || name.startsWith('.') || /\p{Cc}/u.test(name)) return 'That file name can’t be imported.'
    if (!desktopImageKindForName(name)) return 'Only .png, .jpg, and .webp images can be attached.'
    return null
}

async function inspectComposerImage(name: string, bytes: Uint8Array) {
    const problem = imageNameProblem(name)
    if (problem) throw new DesktopHttpError(415, problem)
    const kind = desktopImageKindForName(name)!
    let inspected: ReturnType<typeof inspectDesktopImageBytes>
    try { inspected = inspectDesktopImageBytes(desktopRasterKind(name)!, bytes) }
    catch (error) {
        if (error instanceof DesktopImageBytesError && error.reason === 'animation') throw new DesktopHttpError(415, 'Animated images can’t be attached. Choose a static image.')
        if (error instanceof DesktopImageBytesError && error.reason === 'dimensions') throw new DesktopHttpError(413, 'This image is too large to attach.')
        throw new DesktopHttpError(415, 'This file is not a supported image.')
    }
    try {
        const options = { animated: false, limitInputPixels: DESKTOP_IMAGE_MAX_PIXELS, failOn: 'warning' as const }
        const meta = await sharp(bytes, options).timeout({ seconds: 5 }).metadata()
        if ((meta.pages ?? 1) > 1) throw new DesktopHttpError(415, 'Animated images can’t be attached. Choose a static image.')
        if (meta.width !== inspected.width || meta.height !== inspected.height || meta.format !== kind) throw new DesktopHttpError(415, 'This image has inconsistent dimensions or format.')
        await sharp(bytes, options).timeout({ seconds: 5 }).stats()
    } catch (error) {
        if (error instanceof DesktopHttpError) throw error
        throw new DesktopHttpError(415, 'This image is damaged and can’t be attached.')
    }
    return { kind, ...inspected }
}

export function desktopImageSnapshotId(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

function snapshotExtension(mediaType: DesktopImageMediaType): string {
    if (mediaType === 'image/png') return 'png'
    if (mediaType === 'image/jpeg') return 'jpg'
    if (mediaType === 'image/webp') return 'webp'
    throw new DesktopHttpError(400, 'Choose a valid image attachment.')
}

type SnapshotIdentity = Pick<DesktopImageSnapshot, 'sha256' | 'mediaType'> & Partial<Pick<DesktopImageSnapshot, 'width' | 'height' | 'byteLength'>>
const snapshotName = (image: SnapshotIdentity) => {
    if (!/^[0-9a-f]{64}$/.test(image.sha256)) throw new DesktopHttpError(400, 'Choose a valid image attachment.')
    return `${image.sha256}.${snapshotExtension(image.mediaType)}`
}

async function readSnapshot(store: Store, image: SnapshotIdentity): Promise<{ bytes: Uint8Array; byteLength: number }> {
    const name = snapshotName(image)
    await store.assertCurrent()
    const target = pathAt(store.pinned, name)
    const listed = await stat(target)
    if (!listed) throw unavailable()
    if (!listed.isFile() || listed.isSymbolicLink() || listed.uid !== store.owner || listed.nlink !== BigInt(1)) throw changed()
    if (listed.size < BigInt(1) || listed.size > BigInt(DESKTOP_IMAGE_MAX_BYTES)) throw new DesktopHttpError(415, 'This image attachment is damaged.')
    // The pinned path contains the deliberate /proc fd reference on Linux. Its final entry
    // alone needs O_NOFOLLOW; Darwin uses O_NOFOLLOW_ANY through the volume inode path.
    const handle = await open(/* turbopackIgnore: true */ target, constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW)).catch(error => {
        if (missing(error)) throw unavailable()
        if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw changed()
        throw error
    })
    try {
        const opened = await handle.stat({ bigint: true })
        if (!opened.isFile() || opened.uid !== store.owner || opened.nlink !== BigInt(1) || !sameVersion(opened, listed)) throw changed()
        const bytes = Buffer.alloc(Number(opened.size))
        let got = 0
        while (got < bytes.length) {
            const read = await handle.read(bytes, got, bytes.length - got, got)
            if (!read.bytesRead) break
            got += read.bytesRead
        }
        const [after, still] = await Promise.all([handle.stat({ bigint: true }), stat(target)])
        if (got !== bytes.length || !still?.isFile() || still.uid !== store.owner || after.uid !== store.owner || after.nlink !== BigInt(1) || still.nlink !== BigInt(1) || !sameVersion(opened, after) || !sameVersion(opened, still)) throw changed()
        await store.assertCurrent()
        if (desktopImageSnapshotId(bytes) !== image.sha256) throw changed()
        const inspected = await inspectComposerImage(name, bytes)
        if (inspected.contentType !== image.mediaType || image.width !== undefined && image.width !== inspected.width || image.height !== undefined && image.height !== inspected.height || image.byteLength !== undefined && image.byteLength !== bytes.length) throw changed()
        await store.assertCurrent()
        return { bytes: new Uint8Array(bytes), byteLength: bytes.length }
    } finally { await handle.close() }
}

async function assertStoreBudget(store: Store, byteLength: number) {
    let count = 0
    let bytes = byteLength
    const entries = await opendir(/* turbopackIgnore: true */ store.pinned)
    for await (const entry of entries) {
        if (++count >= DESKTOP_IMAGE_STORE_MAX_FILES) throw new DesktopHttpError(413, 'This coworker’s image storage is full. Existing attachments were kept.')
        const info = await stat(pathAt(store.pinned, entry.name))
        if (!info?.isFile() || info.uid !== store.owner || info.nlink !== BigInt(1)) throw changed()
        bytes += Number(info.size)
        if (bytes > DESKTOP_IMAGE_STORE_MAX_BYTES) throw new DesktopHttpError(413, 'This coworker’s image storage is full. Existing attachments were kept.')
    }
    await store.assertCurrent()
}

async function storeSnapshot(store: Store, image: DesktopImageSnapshot, bytes: Uint8Array): Promise<void> {
    const name = snapshotName(image)
    const target = pathAt(store.pinned, name)
    if (await stat(target)) { await readSnapshot(store, image); return }
    await assertStoreBudget(store, bytes.byteLength)
    const temporary = pathAt(store.pinned, `.rerun-import-${randomBytes(12).toString('hex')}`)
    const handle = await open(/* turbopackIgnore: true */ temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NONBLOCK | (process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW), 0o600)
    let staged: BigIntStats | null = null
    let published = false
    try {
        staged = await handle.stat({ bigint: true })
        const listed = await stat(temporary)
        if (!staged.isFile() || staged.uid !== store.owner || staged.nlink !== BigInt(1) || !listed || !same(staged, listed)) throw changed()
        await handle.writeFile(bytes)
        await handle.sync()
        await store.assertCurrent()
        await link(/* turbopackIgnore: true */ temporary, target)
        published = true
        await store.assertCurrent()
    } catch (error) {
        if (published && staged) {
            const current = await stat(target)
            if (current && same(current, staged)) await unlink(/* turbopackIgnore: true */ target).catch(() => {})
        }
        throw error
    } finally {
        await handle.close()
        const current = await stat(temporary)
        if (staged && current && same(current, staged)) await unlink(/* turbopackIgnore: true */ temporary)
    }
    // Verify the sole-link final snapshot before any visible workspace publication.
    await readSnapshot(store, image)
}

/** Validates and pins the snapshot BEFORE the mature create-only visible publication. A
 * snapshot failure can therefore never be reported as a definitive refusal after Files changed. */
export async function importDesktopComposerImage(runtime: DesktopRuntime, agentId: string, folder: string, name: string, bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<{ path: string; name: string; image: DesktopImageSnapshot }> {
    checkSignal(options.signal)
    if (bytes.byteLength < 1 || bytes.byteLength > DESKTOP_IMAGE_MAX_BYTES) throw new DesktopHttpError(413, 'Images can be up to 8 MB.')
    const inspected = await inspectComposerImage(name, bytes)
    checkSignal(options.signal)
    const path = [...folder.split('/').filter(part => part && part !== '.'), name].join('/')
    const parsed = desktopImageSnapshotSchema.safeParse({ sha256: desktopImageSnapshotId(bytes), name, path, mediaType: desktopImageMediaType(inspected.kind), width: inspected.width, height: inspected.height, byteLength: bytes.byteLength })
    if (!parsed.success) throw new DesktopHttpError(400, 'Choose a valid image attachment and folder.')
    const image = parsed.data
    const imported = await importCoworkerRasterFile(runtime, agentId, folder, name, bytes, async () => {
        checkSignal(options.signal)
        await withStore(runtime, agentId, true, store => storeSnapshot(store, image, bytes))
        checkSignal(options.signal)
    })
    // No fallible work or cancellation checks after visible publication.
    return { ...imported, image }
}

export async function readDesktopImageSnapshot(runtime: DesktopRuntime, agentId: string, image: SnapshotIdentity): Promise<{ bytes: Uint8Array; byteLength: number }> {
    snapshotName(image)
    return withStore(runtime, agentId, false, store => readSnapshot(store, image))
}

export async function readDesktopImageSnapshots(runtime: DesktopRuntime, agentId: string, images: readonly SnapshotIdentity[]): Promise<Map<string, Uint8Array>> {
    if (images.length > DESKTOP_IMAGE_ATTACHMENT_MAX_FILES) throw new DesktopHttpError(413, 'You can attach up to four images.')
    const resolved = new Map<string, Uint8Array>()
    let total = 0
    if (!images.length) return resolved
    await withStore(runtime, agentId, false, async store => {
        for (const image of images) {
            const snapshot = await readSnapshot(store, image)
            total += snapshot.byteLength
            if (total > DESKTOP_IMAGE_ATTACHMENT_TOTAL_MAX_BYTES) throw new DesktopHttpError(413, 'Images must be 16 MB or smaller in total.')
            resolved.set(image.sha256, snapshot.bytes)
        }
    })
    return resolved
}

/** A caller's keep-set can race a saved draft, queue admission or pending send. Retain
 * immutable bounded snapshots until collection can atomically consult every durable owner.
 * Kept for source compatibility; deliberately performs no deletion. */
export async function pruneDesktopImageSnapshots(_runtime: DesktopRuntime, _agentId: string, _keep: ReadonlySet<string>): Promise<number> { return 0 }
