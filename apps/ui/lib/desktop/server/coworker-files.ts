import { canonicalDesktopEngineRoot } from './runtime'
import 'server-only'
import { DESKTOP_ATTACHMENT_MAX_BYTES, isDesktopAttachmentPath } from '@rerun/contracts'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { link, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileEditBlockReason, hashText, looksBinary } from '@/lib/files/editable'
import { DesktopHttpError } from './auth'
import { DESKTOP_AUDIO_MAX_BYTES, DesktopAudioBytesError, desktopAudioKind, inspectDesktopAudioBytes, type DesktopAudioContentType } from './audio-bytes'
import { DESKTOP_VIDEO_MAX_BYTES, DesktopVideoBytesError, desktopVideoKind, inspectDesktopVideoBytes, type DesktopVideoContentType } from './video-bytes'
import { DESKTOP_IMAGE_MAX_BYTES, DesktopImageBytesError, desktopRasterKind, inspectDesktopImageBytes, type DesktopImageContentType } from './image-bytes'
import { bindCoworkerPdfFolder, readCoworkerPdf, type CoworkerPdfPreview } from './pdf-read'
import { bindCoworkerPreviewImageFolder } from './preview-image'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { findDesktopAgent } from './store'
import { withRosterWrite } from './roster-writes'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { assertPrivateBackupBudget, assertPrivateDirectories, assertPrivateSnapshot, privateFileLocation, readPrivateSnapshot, readPrivateTextAt, type PrivateFileSnapshot } from './private-file-tools/snapshot'

export type CoworkerFileEntry = { name: string; type: 'file' | 'dir'; size: number; modifiedAt: string; identity?: string }
/** `hash` is set only when the whole file can be edited as UTF-8 text. */
export type CoworkerFilePreview = { path: string; content: string; size: number; truncated: boolean; hash?: string; identity?: string }

const PREVIEW_BYTES = 256 * 1024
const SAFE_ENGINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const inside = (root: string, target: string) => {
    const rel = relative(root, target)
    return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')

/** The engine stores each agent's workspace under `<engine data>/agents/<id>/workspace` (apps/engine/src/config/paths.ts). */
export async function coworkerWorkspace(runtime: DesktopRuntime, agentId: string): Promise<string> {
    const coworker = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
    if (!coworker) throw new DesktopHttpError(404, 'Coworker not found')
    if (!SAFE_ENGINE_ID.test(coworker.engineAgentId)) throw new DesktopHttpError(400, 'This coworker has no readable workspace.')
    return resolve(await canonicalDesktopEngineRoot(runtime), 'agents', coworker.engineAgentId, 'workspace')
}

/** Relative paths only; the result's real location (after following every symlink) must stay inside the workspace's real location. */
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

// Only open canonical paths. Darwin's O_NOFOLLOW_ANY refuses a symlink swapped into any
// component after realpath. On Linux walk each component from a pinned parent instead.
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

export async function listCoworkerFiles(runtime: DesktopRuntime, agentId: string, path: string, showHidden: boolean): Promise<{ path: string; entries: CoworkerFileEntry[] }> {
    return withCoworkerFiles(runtime, agentId, () => listFiles(runtime, agentId, path, showHidden))
}

// Listing and reading can recover an interrupted save. Order those mutations with imports,
// other saves and deletion, including requests admitted through a different route bundle.
export function withCoworkerFiles<T>(runtime: DesktopRuntime, agentId: string, action: () => Promise<T>): Promise<T> {
    return withRosterWrite(async () => {
        await assertCoworkerNotDeleting(await openDesktopDatabase(runtime.dataRoot), agentId)
        return action()
    })
}

async function listFiles(runtime: DesktopRuntime, agentId: string, path: string, showHidden: boolean): Promise<{ path: string; entries: CoworkerFileEntry[] }> {
    const { root, target, rel } = await containedPath(await coworkerWorkspace(runtime, agentId), path)
    if (!root) return { path: rel, entries: [] }
    if (!target) throw new DesktopHttpError(404, 'Folder not found')
    await recoverInterruptedCoworkerEdits(target, root)
    const handle = await openResolved(target, true)
    const entries: CoworkerFileEntry[] = []
    try {
        const pinned = await pinnedDirectory(handle)
        for (const name of await readdir(pinned)) {
            if (!showHidden && name.startsWith('.')) continue
            // Identity is the directory entry itself. A symlink keeps the link inode, so Delete
            // can refuse it instead of removing the file the link points at.
            const entryIdentity = await fileStat(join(pinned, name))
            let info = entryIdentity
            if (info?.isSymbolicLink()) {
                // Coworker links are read from the running Mac's workspace, outside the build.
                const real = await realpath(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ target, name)).catch(() => null)
                if (!real || !inside(root, real)) continue
                const linked = await openResolved(real).catch(() => null)
                if (!linked) continue
                try { info = await linked.stat({ bigint: true }) } finally { await linked.close() }
            }
            if (!info || (!info.isDirectory() && !info.isFile())) continue
            entries.push({
                name, type: info.isDirectory() ? 'dir' : 'file', size: Number(info.size), modifiedAt: info.mtime.toISOString(),
                ...(entryIdentity && { identity: `${entryIdentity.dev}:${entryIdentity.ino}` }),
            })
        }
    } finally {
        await handle.close()
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    return { path: rel, entries }
}

export async function readCoworkerFile(runtime: DesktopRuntime, agentId: string, path: string, mode: 'preview' | 'attach' = 'preview'): Promise<CoworkerFilePreview> {
    return withCoworkerFiles(runtime, agentId, () => readFileInWorkspace(runtime, agentId, path, mode))
}

async function readFileInWorkspace(runtime: DesktopRuntime, agentId: string, path: string, mode: 'preview' | 'attach'): Promise<CoworkerFilePreview> {
    if (mode === 'attach' && !isDesktopAttachmentPath(path)) throw new DesktopHttpError(400, 'Choose a .txt or .md file from this coworker’s workspace.')
    const workspace = await coworkerWorkspace(runtime, agentId)
    const located = await containedPath(workspace, path)
    if (!located.rel) throw new DesktopHttpError(400, 'Choose a file to preview.')
    const slash = located.rel.lastIndexOf('/')
    const folder = await containedPath(workspace, slash === -1 ? '' : located.rel.slice(0, slash))
    if (!folder.target) throw new DesktopHttpError(404, 'File not found')
    const fileName = located.rel.slice(slash + 1)
    // Wait out an in-process publish, then heal a crash before deciding the file is gone.
    return withSaveLock(join(folder.target, fileName), async () => {
        const recoveries = await recoverInterruptedCoworkerEdits(folder.target!, folder.root!)
        const { target } = await containedPath(workspace, path)
        if (!target) throw new DesktopHttpError(404, 'File not found')
        const interrupted = recoveries.find(item => item.final === fileName)
        if (interrupted && mode === 'preview') {
            const current = await readResolvedFile(target, located.rel, mode)
            const prefix = located.rel.slice(0, -fileName.length)
            const recovery = { draft: prefix + interrupted.recovery.draft, external: prefix + interrupted.recovery.external }
            throw new CoworkerFileConflict(current.hash ? { content: current.content, hash: current.hash, ...(current.identity && { identity: current.identity }) } : null, recovery)
        }
        return readResolvedFile(target, located.rel, mode)
    })
}

async function readResolvedFile(target: string, rel: string, mode: 'preview' | 'attach'): Promise<CoworkerFilePreview> {
    const handle = await openResolved(target)
    try {
        const info = await handle.stat()
        if (!info.isFile()) throw new DesktopHttpError(400, 'That path is not a file.')
        if (mode === 'attach' && info.size > DESKTOP_ATTACHMENT_MAX_BYTES) throw new DesktopHttpError(413, 'Attachments must be 32 KiB or smaller.')
        const buffer = Buffer.alloc(Math.min(info.size, PREVIEW_BYTES))
        let bytesRead = 0
        while (bytesRead < buffer.length) {
            const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
            if (!read.bytesRead) break
            bytesRead += read.bytesRead
        }
        const bytes = buffer.subarray(0, bytesRead)
        if (bytes.includes(0)) throw new DesktopHttpError(415, mode === 'attach' ? 'Attachments must contain UTF-8 text.' : 'Only text files can be previewed.')
        let content: string
        if (mode === 'attach') {
            const after = await handle.stat()
            if (bytesRead !== info.size || info.size !== after.size || info.ctimeMs !== after.ctimeMs) throw new DesktopHttpError(409, 'This file changed while it was being read. Try sending again.')
            try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
            catch { throw new DesktopHttpError(415, 'Attachments must contain UTF-8 text.') }
            if (bytes.some(byte => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)) throw new DesktopHttpError(415, 'Attachments must contain UTF-8 text.')
        } else content = bytes.toString('utf8')
        const truncated = info.size > bytesRead
        const identified = await handle.stat({ bigint: true })
        const text = mode === 'preview' && !truncated && identified.size === BigInt(bytesRead)
            && canEditCoworkerFileName(basename(rel)) && canEditCoworkerFileName(basename(target)) ? editableText(bytes) : null
        return { path: rel, content, size: info.size, truncated, identity: `${identified.dev}:${identified.ino}`, ...(text !== null ? { hash: hashText(text) } : {}) }
    } finally {
        await handle.close()
    }
}

export type CoworkerImagePreview = { path: string; name: string; bytes: Uint8Array; contentType: DesktopImageContentType; identity: string; width: number; height: number }

const IMAGE_IDENTITY = /^\d{1,24}:\d{1,24}$/
const MAX_IMAGE_DEPTH = 64
// Darwin's O_NOFOLLOW_ANY already covers every component and must not be combined with O_NOFOLLOW.
const IMAGE_FILE_OPEN = constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW)

/** Read one existing PNG, JPEG, WebP, or GIF for the Files preview. Text read, import, and
 * attachment stay on their own paths. The response is the file's own bytes, never a filesystem URL. */
export async function readCoworkerImage(runtime: DesktopRuntime, agentId: string, path: string, identity?: string): Promise<CoworkerImagePreview> {
    return withCoworkerFiles(runtime, agentId, () => readImage(runtime, agentId, path, identity))
}

async function readImage(runtime: DesktopRuntime, agentId: string, path: string, identity?: string): Promise<CoworkerImagePreview> {
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
    await recoverInterruptedCoworkerEdits(parentPath, root.root)
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
    if (claimed(parentPath, name)) throw new DesktopHttpError(409, 'This file is being saved. Try the preview again once that finishes.')
    // This is a runtime coworker path. Tracing a dynamic realpath at build time
    // otherwise sweeps the source tree into Next's standalone application.
    const canonical = await realpath(/* turbopackIgnore: true */ located).catch(() => null)
    if (canonical !== located || !inside(root.root, canonical)) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
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
            const buffer = Buffer.alloc(length)
            let got = 0
            while (got < length) {
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
            let inspected: ReturnType<typeof inspectDesktopImageBytes>
            try { inspected = inspectDesktopImageBytes(kind, buffer.subarray(0, got)) }
            catch (error) {
                if (error instanceof DesktopImageBytesError && error.reason === 'dimensions') throw new DesktopHttpError(413, 'This image is too large to preview.')
                if (error instanceof DesktopImageBytesError && error.reason === 'mismatch') throw new DesktopHttpError(415, 'This file is not a supported image.')
                if (error instanceof DesktopImageBytesError && error.reason === 'animation') throw new DesktopHttpError(415, 'Animated images can’t be previewed yet. Choose a static image.')
                throw new DesktopHttpError(415, 'This image is damaged and can’t be previewed.')
            }
            return { path: rel, name, bytes: new Uint8Array(buffer.subarray(0, got)), contentType: inspected.contentType, identity: `${listed.dev}:${listed.ino}`, width: inspected.width, height: inspected.height }
        } finally { await handle.close() }
    } finally { await dir.close() }
}

export type CoworkerAudioPreview = { path: string; name: string; bytes: Uint8Array; contentType: DesktopAudioContentType; identity: string }

const AUDIO_IDENTITY = /^\d{1,24}:\d{1,24}$/
const MAX_AUDIO_DEPTH = 64
// Darwin's O_NOFOLLOW_ANY already covers every component and must not be combined with O_NOFOLLOW.
const AUDIO_FILE_OPEN = constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW)

/** Read one existing WAV, MP3, M4A, Ogg or FLAC for the Files preview. Text, image, import, and attachment stay
 * on their own paths. The response is the file's own bytes, never a filesystem URL. */
export async function readCoworkerAudio(runtime: DesktopRuntime, agentId: string, path: string, identity?: string): Promise<CoworkerAudioPreview> {
    return withCoworkerFiles(runtime, agentId, () => readAudio(runtime, agentId, path, identity))
}

async function readAudio(runtime: DesktopRuntime, agentId: string, path: string, identity?: string): Promise<CoworkerAudioPreview> {
    if (identity !== undefined && !AUDIO_IDENTITY.test(identity)) throw new DesktopHttpError(400, 'Send the audio to preview.')
    const rel = lexicalRelative(path)
    if (!rel) throw new DesktopHttpError(400, 'Choose an audio file to preview.')
    const parts = rel.split('/')
    if (parts.length > MAX_AUDIO_DEPTH) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const name = parts[parts.length - 1]!
    if (parts.some(part => !simpleName(part) || reservedName(part))) throw new DesktopHttpError(400, 'That name can’t be previewed.')
    const kind = desktopAudioKind(name)
    if (!kind) throw new DesktopHttpError(415, 'Only WAV, MP3, M4A, Ogg and FLAC files can be previewed.')
    const workspace = await coworkerWorkspace(runtime, agentId)
    const root = await containedPath(workspace, '')
    if (!root.root) throw new DesktopHttpError(404, `“${name}” was not found.`)
    const uid = currentUid('Audio preview is only available on this Mac.')
    const parentRel = parts.slice(0, -1).join('/')
    const parentPath = join(/* turbopackIgnore: true */ root.root, parentRel)
    await assertAudioDirectories(root.root, parts.slice(0, -1), uid, name)
    await recoverInterruptedCoworkerEdits(parentPath, root.root)
    const parents = await assertAudioDirectories(root.root, parts.slice(0, -1), uid, name)
    const located = join(/* turbopackIgnore: true */ parentPath, name)
    const listed = await fileStat(located)
    if (!listed) throw new DesktopHttpError(404, `“${name}” was not found.`)
    if (listed.isSymbolicLink()) throw new DesktopHttpError(400, 'Choose an audio file, not a symlink.')
    if (!listed.isFile()) throw new DesktopHttpError(400, 'That path is not a file.')
    if (listed.uid !== uid) throw new DesktopHttpError(403, 'This file belongs to another user. It was left unopened.')
    if (listed.nlink !== BigInt(1)) throw new DesktopHttpError(400, 'This audio has another link. It was left unopened.')
    if (identity && `${listed.dev}:${listed.ino}` !== identity) throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
    if (listed.size === BigInt(0)) throw new DesktopHttpError(415, 'This audio is damaged and can’t be previewed.')
    if (listed.size > BigInt(DESKTOP_AUDIO_MAX_BYTES)) throw new DesktopHttpError(413, 'Audio files can be up to 16 MB.')
    if (claimed(parentPath, name)) throw new DesktopHttpError(409, 'This file is being saved. Try the preview again once that finishes.')
    // This is a runtime coworker path. Tracing a dynamic realpath at build time
    // otherwise sweeps the source tree into Next's standalone application.
    const canonical = await realpath(/* turbopackIgnore: true */ located).catch(() => null)
    if (canonical !== located || !inside(root.root, canonical)) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const dir = await openResolved(parentPath, true)
    try {
        const pinned = await pinnedDirectory(dir)
        const openedParent = await dir.stat({ bigint: true })
        if (!sameFile(openedParent, parents[parents.length - 1] ?? null) || openedParent.uid !== uid) {
            throw new DesktopHttpError(400, 'That folder changed. The audio was left unopened.')
        }
        const handle = await open(join(pinned, name), AUDIO_FILE_OPEN).catch(error => {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ELOOP' || code === 'ENOTDIR') throw new DesktopHttpError(400, 'Choose an audio file, not a symlink.')
            if (code === 'ENOENT') throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
            throw error
        })
        try {
            const opened = await handle.stat({ bigint: true })
            if (!sameFile(opened, listed) || opened.isSymbolicLink() || !opened.isFile() || opened.uid !== uid || opened.nlink !== BigInt(1)) {
                throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
            }
            const length = Number(opened.size)
            if (!Number.isSafeInteger(length) || length > DESKTOP_AUDIO_MAX_BYTES) throw new DesktopHttpError(413, 'Audio files can be up to 16 MB.')
            if (length < 1) throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
            const buffer = Buffer.alloc(length)
            let got = 0
            while (got < length) {
                const read = await handle.read(buffer, got, length - got, got)
                if (!read.bytesRead) break
                got += read.bytesRead
            }
            const after = await handle.stat({ bigint: true })
            const still = await fileStat(join(pinned, name))
            if (got !== length || !sameFile(after, listed) || after.size !== opened.size || !sameFile(still, listed)) {
                throw new DesktopHttpError(409, 'This audio changed while it was being read.')
            }
            for (const parent of parents) {
                const now = await fileStat(parent.path)
                if (!now || now.isSymbolicLink() || !now.isDirectory() || !sameFile(now, parent) || now.uid !== uid) {
                    throw new DesktopHttpError(400, 'That folder changed. The audio was left unopened.')
                }
            }
            let inspected: ReturnType<typeof inspectDesktopAudioBytes>
            try { inspected = inspectDesktopAudioBytes(kind, buffer.subarray(0, got)) }
            catch (error) {
                if (error instanceof DesktopAudioBytesError && error.reason === 'mismatch') throw new DesktopHttpError(415, 'This file is not a supported audio file.')
                if (error instanceof DesktopAudioBytesError && error.reason === 'unsupported') throw new DesktopHttpError(415, 'This audio format can’t be previewed.')
                throw new DesktopHttpError(415, 'This audio is damaged and can’t be previewed.')
            }
            return { path: rel, name, bytes: new Uint8Array(buffer.subarray(0, got)), contentType: inspected.contentType, identity: `${listed.dev}:${listed.ino}` }
        } finally { await handle.close() }
    } finally { await dir.close() }
}

export type CoworkerVideoPreview = { path: string; name: string; bytes: Uint8Array; contentType: DesktopVideoContentType; identity: string }

const VIDEO_IDENTITY = /^\d{1,24}:\d{1,24}$/
const MAX_VIDEO_DEPTH = 64
// Darwin's O_NOFOLLOW_ANY already covers every component and must not be combined with O_NOFOLLOW.
const VIDEO_FILE_OPEN = constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW)

/** Read one existing MP4, WebM, MOV or M4V for the Files preview. Text, image, audio, import, and attachment stay
 * on their own paths. The response is the file's own bytes, never a filesystem URL. */
export async function readCoworkerVideo(runtime: DesktopRuntime, agentId: string, path: string, identity?: string): Promise<CoworkerVideoPreview> {
    return withCoworkerFiles(runtime, agentId, () => readVideo(runtime, agentId, path, identity))
}

async function readVideo(runtime: DesktopRuntime, agentId: string, path: string, identity?: string): Promise<CoworkerVideoPreview> {
    if (identity !== undefined && !VIDEO_IDENTITY.test(identity)) throw new DesktopHttpError(400, 'Send the video to preview.')
    const rel = lexicalRelative(path)
    if (!rel) throw new DesktopHttpError(400, 'Choose a video file to preview.')
    const parts = rel.split('/')
    if (parts.length > MAX_VIDEO_DEPTH) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const name = parts[parts.length - 1]!
    if (parts.some(part => !simpleName(part) || reservedName(part))) throw new DesktopHttpError(400, 'That name can’t be previewed.')
    const kind = desktopVideoKind(name)
    if (!kind) throw new DesktopHttpError(415, 'Only MP4, WebM, MOV and M4V files can be previewed.')
    const workspace = await coworkerWorkspace(runtime, agentId)
    const root = await containedPath(workspace, '')
    if (!root.root) throw new DesktopHttpError(404, `“${name}” was not found.`)
    const uid = currentUid('Video preview is only available on this Mac.')
    const parentRel = parts.slice(0, -1).join('/')
    const parentPath = join(/* turbopackIgnore: true */ root.root, parentRel)
    await assertVideoDirectories(root.root, parts.slice(0, -1), uid, name)
    await recoverInterruptedCoworkerEdits(parentPath, root.root)
    const parents = await assertVideoDirectories(root.root, parts.slice(0, -1), uid, name)
    const located = join(/* turbopackIgnore: true */ parentPath, name)
    const listed = await fileStat(located)
    if (!listed) throw new DesktopHttpError(404, `“${name}” was not found.`)
    if (listed.isSymbolicLink()) throw new DesktopHttpError(400, 'Choose a video file, not a symlink.')
    if (!listed.isFile()) throw new DesktopHttpError(400, 'That path is not a file.')
    if (listed.uid !== uid) throw new DesktopHttpError(403, 'This file belongs to another user. It was left unopened.')
    if (listed.nlink !== BigInt(1)) throw new DesktopHttpError(400, 'This video has another link. It was left unopened.')
    if (identity && `${listed.dev}:${listed.ino}` !== identity) throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
    if (listed.size === BigInt(0)) throw new DesktopHttpError(415, 'This video is damaged and can’t be previewed.')
    if (listed.size > BigInt(DESKTOP_VIDEO_MAX_BYTES)) throw new DesktopHttpError(413, 'Video files can be up to 16 MB.')
    if (claimed(parentPath, name)) throw new DesktopHttpError(409, 'This file is being saved. Try the preview again once that finishes.')
    // This is a runtime coworker path. Tracing a dynamic realpath at build time
    // otherwise sweeps the source tree into Next's standalone application.
    const canonical = await realpath(/* turbopackIgnore: true */ located).catch(() => null)
    if (canonical !== located || !inside(root.root, canonical)) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const dir = await openResolved(parentPath, true)
    try {
        const pinned = await pinnedDirectory(dir)
        const openedParent = await dir.stat({ bigint: true })
        if (!sameFile(openedParent, parents[parents.length - 1] ?? null) || openedParent.uid !== uid) {
            throw new DesktopHttpError(400, 'That folder changed. The video was left unopened.')
        }
        const handle = await open(join(pinned, name), VIDEO_FILE_OPEN).catch(error => {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ELOOP' || code === 'ENOTDIR') throw new DesktopHttpError(400, 'Choose a video file, not a symlink.')
            if (code === 'ENOENT') throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
            throw error
        })
        try {
            const opened = await handle.stat({ bigint: true })
            if (!sameFile(opened, listed) || opened.isSymbolicLink() || !opened.isFile() || opened.uid !== uid || opened.nlink !== BigInt(1)) {
                throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
            }
            const length = Number(opened.size)
            if (!Number.isSafeInteger(length) || length > DESKTOP_VIDEO_MAX_BYTES) throw new DesktopHttpError(413, 'Video files can be up to 16 MB.')
            if (length < 1) throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
            const buffer = Buffer.alloc(length)
            let got = 0
            while (got < length) {
                const read = await handle.read(buffer, got, length - got, got)
                if (!read.bytesRead) break
                got += read.bytesRead
            }
            const after = await handle.stat({ bigint: true })
            const still = await fileStat(join(pinned, name))
            if (got !== length || !sameFile(after, listed) || after.size !== opened.size || !sameFile(still, listed)) {
                throw new DesktopHttpError(409, 'This video changed while it was being read.')
            }
            for (const parent of parents) {
                const now = await fileStat(parent.path)
                if (!now || now.isSymbolicLink() || !now.isDirectory() || !sameFile(now, parent) || now.uid !== uid) {
                    throw new DesktopHttpError(400, 'That folder changed. The video was left unopened.')
                }
            }
            let inspected: ReturnType<typeof inspectDesktopVideoBytes>
            try { inspected = inspectDesktopVideoBytes(kind, buffer.subarray(0, got)) }
            catch (error) {
                if (error instanceof DesktopVideoBytesError && error.reason === 'mismatch') throw new DesktopHttpError(415, 'This file is not a supported video file.')
                if (error instanceof DesktopVideoBytesError && error.reason === 'unsupported') throw new DesktopHttpError(415, 'This video format can’t be previewed.')
                throw new DesktopHttpError(415, 'This video is damaged and can’t be previewed.')
            }
            return { path: rel, name, bytes: new Uint8Array(buffer.subarray(0, got)), contentType: inspected.contentType, identity: `${listed.dev}:${listed.ino}` }
        } finally { await handle.close() }
    } finally { await dir.close() }
}

function lexicalRelative(path: string): string {
    const rel = path.split('/').filter(part => part && part !== '.').join('/')
    if (isAbsolute(path) || path.includes('\0') || rel.split('/').includes('..')) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    return rel
}

function currentUid(unavailable = 'Image preview is only available on this Mac.'): bigint {
    if (typeof process.getuid !== 'function') throw new DesktopHttpError(400, unavailable)
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

async function assertAudioDirectories(root: string, directories: string[], uid: bigint, fileName: string): Promise<Array<FileIdentity & { path: string }>> {
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
        if (info.isSymbolicLink()) throw new DesktopHttpError(400, 'Choose an audio file, not a symlink.')
        if (!info.isDirectory()) throw new DesktopHttpError(400, 'That path is not a folder.')
        if (info.uid !== uid) throw new DesktopHttpError(403, 'This file belongs to another user. It was left unopened.')
        parents.push({ path: directory, dev: info.dev, ino: info.ino })
    }
    return parents
}

async function assertVideoDirectories(root: string, directories: string[], uid: bigint, fileName: string): Promise<Array<FileIdentity & { path: string }>> {
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
        if (info.isSymbolicLink()) throw new DesktopHttpError(400, 'Choose a video file, not a symlink.')
        if (!info.isDirectory()) throw new DesktopHttpError(400, 'That path is not a folder.')
        if (info.uid !== uid) throw new DesktopHttpError(403, 'This file belongs to another user. It was left unopened.')
        parents.push({ path: directory, dev: info.dev, ino: info.ino })
    }
    return parents
}

export const IMPORT_BYTES = 1024 * 1024
const IMPORTABLE = /\.(txt|md)$/i

/**
 * Copies one .txt/.md file into `folder` of the coworker's workspace. Never overwrites: an existing
 * name (including a symlink) is reported as 409. The folder must resolve inside the workspace, and
 * the create itself refuses symlinks in any component, so a swapped folder cannot redirect the write.
 */
async function assertPrivateToolLocation(workspace:string,path:string,mustExist:boolean) {
    const located=await containedPath(workspace,path)
    if(!located.root || path.split('/').some(part=>!part || part.startsWith('.')))throw new DesktopHttpError(400,'Choose an existing visible private Files location.')
    const expected=join(/* turbopackIgnore: true */ located.root,path)
    const parent=await realpath(/* turbopackIgnore: true */ dirname(/* turbopackIgnore: true */ expected)).catch(()=>null)
    if(parent!==dirname(expected) || located.target && located.target!==expected || mustExist && !located.target)throw new DesktopHttpError(400,'Private file tools cannot follow symlinks or create folders.')
}

export type PrivateToolPublication = { beforePublish: () => Promise<void>; existingDirectoryOnly: true; snapshot?: PrivateFileSnapshot }

/** Model reads are complete snapshots, do not follow hardlinks and cannot recover unrelated edits. */
export async function readPrivateCoworkerFile(runtime: DesktopRuntime, agentId: string, path: string, beforeRead: () => Promise<void>): Promise<PrivateFileSnapshot> {
    return withCoworkerFiles(runtime, agentId, async () => {
        await beforeRead()
        const workspace = await coworkerWorkspace(runtime, agentId)
        return withSaveLock(join(/* turbopackIgnore: true */ workspace, path), async () => {
            await beforeRead()
            const location = await privateFileLocation(workspace, path)
            const snapshot = await readPrivateSnapshot(location)
            await beforeRead()
            await assertPrivateSnapshot(snapshot)
            return snapshot
        })
    })
}

export async function importCoworkerFile(runtime: DesktopRuntime, agentId: string, folder: string, name: string, bytes: Uint8Array, publication?: PrivateToolPublication): Promise<{ path: string; name: string }> {
    // Imports can create a previously absent workspace. Keep that whole mutation ordered with
    // deletion so an old file picker cannot recreate the removed coworker's folder.
    return withRosterWrite(async () => {
        await publication?.beforePublish()
        await assertCoworkerNotDeleting(await openDesktopDatabase(runtime.dataRoot), agentId)
        return importFile(runtime, agentId, folder, name, bytes, publication)
    })
}

/** Trusted composer raster import. Reuses the text import's recovery, pinned staging and
 * create-only publication; the caller pins the private snapshot before the visible link. */
export async function importCoworkerRasterFile(runtime: DesktopRuntime, agentId: string, folder: string, name: string, bytes: Uint8Array, beforePublish: (workspace: string) => Promise<void>): Promise<{ path: string; name: string }> {
    return withCoworkerFiles(runtime, agentId, () => importFile(runtime, agentId, folder, name, bytes, undefined, beforePublish))
}

async function importFile(runtime: DesktopRuntime, agentId: string, folder: string, name: string, bytes: Uint8Array, publication?: PrivateToolPublication, beforeRasterPublish?: (workspace: string) => Promise<void>): Promise<{ path: string; name: string }> {
    if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || name.startsWith('.')) throw new DesktopHttpError(400, 'That file name can’t be imported.')
    if (beforeRasterPublish) {
        const kind = desktopRasterKind(name)
        if (!kind || kind === 'gif' || bytes.byteLength < 1 || bytes.byteLength > DESKTOP_IMAGE_MAX_BYTES) throw new DesktopHttpError(415, 'Choose a supported static image.')
        try { inspectDesktopImageBytes(kind, bytes) } catch { throw new DesktopHttpError(415, 'Choose a supported static image.') }
    } else {
        if (!IMPORTABLE.test(name)) throw new DesktopHttpError(415, 'Only .txt and .md files can be imported.')
        if (bytes.byteLength > IMPORT_BYTES) throw new DesktopHttpError(413, 'Files can be up to 1 MB.')
        if (bytes.includes(0)) throw new DesktopHttpError(415, 'Only text files can be imported.')
    }
    const workspace = await coworkerWorkspace(runtime, agentId)
    if(publication)await assertPrivateToolLocation(workspace,folder?`${folder}/${name}`:name,false)
    let resolved = await containedPath(workspace, folder)
    if (!resolved.root && !resolved.rel && !publication?.existingDirectoryOnly) {
        await createWorkspace(runtime, workspace)
        resolved = await containedPath(workspace, folder)
    }
    const { target, rel } = resolved
    if(publication && target!==join(/* turbopackIgnore: true */ resolved.root ?? '',folder))throw new DesktopHttpError(400,'Private file tools cannot follow symlinks.')
    if (!target) throw new DesktopHttpError(404, 'Folder not found')
    const path = rel ? `${rel}/${name}` : name
    const privateLocation = publication ? await privateFileLocation(workspace, path) : null
    if (!publication) await recoverInterruptedCoworkerEdits(target, resolved.root!)
    const rasterUid = currentUid()
    const rasterParents = await assertImageDirectories(resolved.root!, relative(resolved.root!, target).split(sep).filter(Boolean), rasterUid, name)
    const assertRasterParents = async () => {
        for (const parent of rasterParents) {
            const current = await fileStat(parent.path)
            if (current?.isSymbolicLink()) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
            if (!current?.isDirectory() || current.uid !== rasterUid || !sameFile(current, parent)) throw new DesktopHttpError(409, 'The folder changed. Import the file again.')
        }
    }
    const outside = () => new DesktopHttpError(400, 'That path is outside this coworker’s workspace or is not a folder.')
    const exists = () => new DesktopHttpError(409, `This folder already has a file named “${name}”. The existing file was kept; rename yours and import it again.`)
    const fsError = (error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') return exists()
        if (code === 'ELOOP' || code === 'ENOTDIR') return outside()
        if (code === 'ENOENT') return new DesktopHttpError(404, 'Folder not found')
        return error
    }
    // Write a hidden temp file in the pinned folder, then publish it with link(2), which fails with
    // EEXIST rather than replacing a file. The final name only ever appears complete, a failed write
    // leaves it free, and a racing import that published first is never overwritten.
    const tempName = `.rerun-import-${randomBytes(12).toString('hex')}`
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    let dir: FileHandle
    try {
        dir = await openResolved(target, true)
    } catch (error) { throw fsError(error) }
    try {
        const pinned = await pinnedDirectory(dir)
        {
            await assertRasterParents()
            if (!sameFile(await dir.stat({ bigint: true }), rasterParents.at(-1) ?? null)) throw outside()
        }
        if (await lstat(join(/* turbopackIgnore: true */ pinned, name)).then(() => true, () => false)) throw exists()
        let handle: FileHandle
        try {
            // O_NOFOLLOW_ANY (Darwin) must not be combined with O_NOFOLLOW; it already covers every component.
            handle = process.platform === 'darwin'
                ? await open(join(/* turbopackIgnore: true */ pinned, tempName), flags | 0x20000000, 0o644)
                : await open(`${pinned}/${tempName}`, flags | constants.O_NOFOLLOW, 0o644)
        } catch (error) { throw fsError(error) }
        let tempPath: string | null = join(/* turbopackIgnore: true */ pinned, tempName)
        try {
            let published = false
            try {
                // The temp file must be the one in the pinned folder, not a swapped-in lookalike.
                const [opened, listed] = await Promise.all([handle.stat({ bigint: true }), lstat(tempPath, { bigint: true })])
                if (opened.ino !== listed.ino || opened.dev !== listed.dev) throw outside()
                await handle.writeFile(bytes)
                await handle.sync()
            } finally {
                await handle.close()
            }
            try {
                await publication?.beforePublish()
                await assertRasterParents()
                await beforeRasterPublish?.(workspace)
                await assertRasterParents()
                if(publication){
                    await assertPrivateDirectories(privateLocation!)
                    await assertPrivateToolLocation(workspace,path,false)
                    const [opened,current]=await Promise.all([dir.stat({bigint:true}),lstat(target,{bigint:true})])
                    if(opened.dev!==current.dev || opened.ino!==current.ino)throw outside()
                }
                await link(tempPath, join(/* turbopackIgnore: true */ pinned, name))
                published = true
                {
                    // Publication already happened. A subsequent identity failure must remain
                    // ambiguous to the upload controller, even if best-effort rollback succeeds.
                    try { await assertRasterParents() }
                    catch {
                        const destination = join(/* turbopackIgnore: true */ pinned, name)
                        const [created, staged] = await Promise.all([fileStat(destination), fileStat(tempPath)])
                        if (sameFile(created, staged)) await removeName(destination)
                        throw new DesktopHttpError(500, 'The file import result could not be confirmed. Check Files before retrying.')
                    }
                }
                // A parent moved during link must not leave our newly created file in another workspace.
                if (privateLocation) {
                    try { await assertPrivateDirectories(privateLocation) }
                    catch (error) {
                        const [created, staged] = await Promise.all([fileStat(join(pinned, name)), fileStat(tempPath)])
                        if (sameFile(created, staged)) await removeName(join(pinned, name))
                        throw error
                    }
                }
            } catch (error) {
                if (published) throw new DesktopHttpError(500, 'The file import result could not be confirmed. Check Files before retrying.')
                throw fsError(error)
            }
        } finally {
            if (tempPath) await unlink(tempPath).catch(() => {})
            tempPath = null
        }
    } finally {
        await dir.close()
    }
    return { path, name }
}

/**
 * Creates a missing workspace one folder at a time. Every existing ancestor must already be its own
 * real path, so a coworker directory that is a symlink to a sibling (existing or not) is refused
 * before any folder is made, and each folder we make is checked to be a real directory.
 */
async function createWorkspace(runtime: DesktopRuntime, workspace: string): Promise<void> {
    const base = resolve(await realpath(runtime.dataRoot))
    if (!inside(base, workspace)) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const missingParts: string[] = []
    let existing = workspace
    while (existing !== base) {
        const info = await lstat(existing).catch(error => { if (missing(error)) return null; throw error })
        if (info) {
            if (!info.isDirectory() || await realpath(existing) !== existing) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
            break
        }
        missingParts.unshift(existing)
        existing = dirname(existing)
    }
    for (const part of missingParts) {
        const parent = await openResolved(dirname(part), true)
        try {
            // Pin the parent for mkdir itself. Checking the absolute path afterwards is too late if
            // an ancestor was exchanged for a sibling symlink between validation and creation.
            const child = join(await pinnedDirectory(parent), basename(part))
            await mkdir(child).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
            const info = await lstat(child)
            const actual = await realpath(part).catch(error => { if (missing(error)) return null; throw error })
            if (!info.isDirectory() || actual !== part) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
        } finally {
            await parent.close()
        }
    }
}

const PRIVATE_TOOL_EDITABLE = /\.(txt|md)$/i
export const EDIT_BYTES = PREVIEW_BYTES

function canEditCoworkerFileName(name: string): boolean {
    return simpleName(name) && !name.startsWith('.') && fileEditBlockReason({ name, truncated: false, content: null }) === null
}

/** The strict UTF-8 text of `bytes`, or null when saving it back as text would change it. */
function editableText(bytes: Uint8Array): string | null {
    if (bytes.includes(0)) return null
    try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
        return looksBinary(text) ? null : text
    } catch { return null }
}

export type SaveCoworkerFileResult = { path: string; hash: string; size: number; identity?: string }
export type CoworkerFileRecovery = { draft: string; external: string }
/** Thrown when the file on disk is not what the editor opened; carries the newer text so neither version is lost. */
export class CoworkerFileConflict extends Error {
    constructor(
        readonly current: { content: string; hash: string; identity?: string } | null,
        readonly recovery?: CoworkerFileRecovery,
        readonly stale = false,
    ) { super(stale ? 'This file was moved or replaced. The draft was not written.' : 'This file changed on disk since you opened it.') }
}

const EDIT_PREFIX = '.rerun-edit-'
const BACKUP_PREFIX = '.rerun-backup-'
const PUBLISH_PREFIX = '.rerun-publish-'
const RENAME_PREFIX = '.rerun-rename-'
const DELETE_PREFIX = '.rerun-delete-'
const reservedName = (name: string) => name.startsWith(EDIT_PREFIX) || name.startsWith(BACKUP_PREFIX) || name.startsWith(PUBLISH_PREFIX) || name.startsWith(RENAME_PREFIX) || name.startsWith(DELETE_PREFIX) || name.startsWith('.rerun-import-') || name.startsWith('.rerun-retire-')
/** Crash steps for the publication interruption test. Unset in the app, so these never fire. */
export const COWORKER_PUBLISH_CRASH_STEPS = ['temp', 'prepared', 'renamed', 'uncommitted', 'linked'] as const
const activeNames = new Set<string>()
const claimKey = (directory: string, name: string) => `${directory}\0${name}`
const claim = (directory: string, name: string) => activeNames.add(claimKey(directory, name))
const unclaim = (directory: string, name: string) => activeNames.delete(claimKey(directory, name))
const claimed = (directory: string, name: string) => activeNames.has(claimKey(directory, name))

// PDF reads use this module's recovery and active claims, under the same roster queue.
// Binding the closures here avoids a second journal implementation or claim registry.
bindCoworkerPdfFolder({
    recoverInterruptedEdits: (directory, workspaceRoot) => recoverInterruptedCoworkerEdits(directory, workspaceRoot),
    claimed,
})

bindCoworkerPreviewImageFolder({
    recoverInterruptedEdits: (directory, workspaceRoot) => recoverInterruptedCoworkerEdits(directory, workspaceRoot),
    claimed,
})
export { readCoworkerPdf, type CoworkerPdfPreview }

function crashPublish(step: (typeof COWORKER_PUBLISH_CRASH_STEPS)[number]) {
    if (process.env.RERUN_FILE_PUBLISH_CRASH === step) process.kill(process.pid, 'SIGKILL')
}

async function fileStat(path: string) {
    try { return await lstat(path, { bigint: true }) }
    catch (error) { if (missing(error)) return null; throw error }
}

async function removeName(path: string) {
    try { await unlink(path) } catch (error) { if (!missing(error)) throw error }
}

type FileIdentity = { dev: bigint; ino: bigint }
const sameFile = (left: FileIdentity | null, right: FileIdentity | null) => !!left && !!right && left.dev === right.dev && left.ino === right.ino

async function retireName(path: string, expected: FileIdentity): Promise<boolean> {
    const retirement = join(dirname(path), `.rerun-retire-${randomBytes(12).toString('hex')}`)
    try { await rename(path, retirement) } catch (error) { if (missing(error)) return true; throw error }
    const moved = await fileStat(retirement)
    if (sameFile(moved, expected)) {
        await removeName(retirement)
        return true
    }
    if (moved) {
        try {
            await link(retirement, path)
            await removeName(retirement)
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    return false
}

const execFileAsync = promisify(execFile)
/** The shell validates this bundled executable before launching the UI. Never fall back to a
 * replacement rename, a shell command, a host interpreter or a compiler at runtime. */
async function renameWithoutReplace(directory: string, parent: FileIdentity, source: string, identity: FileIdentity, destination: string) {
    const helper = process.env.RERUN_DESKTOP_RENAME_HELPER
    if (!helper || !isAbsolute(helper)) throw new DesktopHttpError(503, 'The safe rename helper is unavailable. Reopen the app and try again.')
    let output: string
    try {
        output = (await execFileAsync(helper, [directory, String(parent.dev), String(parent.ino), source, String(identity.dev), String(identity.ino), destination], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4096 })).stdout
    } catch (error) {
        const result = error as { stdout?: string }
        if (!result.stdout) throw new DesktopHttpError(503, 'Could not safely rename this entry. Refresh Files before trying again.')
        output = result.stdout
    }
    let result: { ok?: boolean; code?: string }
    try { result = JSON.parse(output) } catch { throw new DesktopHttpError(503, 'Could not confirm this rename. Refresh Files before trying again.') }
    if (result.ok === true) return
    const code = typeof result.code === 'string' && /^(EEXIST|ENOENT|ENOTDIR|ELOOP|ESTALE|EINVAL|EACCES|EPERM|EXDEV|ENOTSUP|EIO)$/.test(result.code) ? result.code : 'EIO'
    throw Object.assign(new Error('Safe rename refused'), { code })
}
async function inodeMayBeHeld(path: string): Promise<boolean> {
    if (process.platform !== 'darwin') return true
    try {
        const { stdout, stderr } = await execFileAsync('/usr/sbin/lsof', ['-nP', '-F', 'p', '--', path], { encoding: 'utf8', timeout: 5000 })
        return stdout.trim().length > 0 || stderr.trim().length > 0
    } catch (error) {
        const result = error as { code?: number; stdout?: string; stderr?: string }
        if (result.code === 1 && !result.stdout && !result.stderr) return false
        return true
    }
}

async function recoveryLinks(directory: string, finalName: string, tempPath: string, backupPath: string): Promise<CoworkerFileRecovery> {
    const extension = extname(finalName)
    const stem = basename(finalName, extension)
    const token = randomBytes(6).toString('hex')
    const recoveryName = (kind: 'draft' | 'external') => {
        const name = `${stem}.${kind}-${token}${extension}`
        return Buffer.byteLength(name) <= 255 ? name : `file.${kind}-${token}.txt`
    }
    const draftName = recoveryName('draft')
    const externalName = recoveryName('external')
    const externalPath = join(directory, externalName)
    await link(backupPath, externalPath)
    try { await link(tempPath, join(directory, draftName)) } catch (error) {
        await removeName(externalPath)
        throw error
    }
    return { draft: draftName, external: externalName }
}

const simpleName = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && !name.includes('/') && !name.includes('\\') && !name.includes('\0') && name !== '.' && name !== '..'

type PublishJournal = { v: 1, final: string, temp: string, backup: string, phase: 'prepared' | 'linked', baseHash: string, retainBackup?: true }
export type InterruptedCoworkerRecovery = { final: string; recovery: CoworkerFileRecovery }

function parseJournal(raw: string): PublishJournal | null {
    try {
        const value = JSON.parse(raw) as Partial<PublishJournal>
        if (value.v !== 1 || (value.phase !== 'prepared' && value.phase !== 'linked')) return null
        if (!simpleName(value.final) || value.final.startsWith('.')) return null
        if (!simpleName(value.temp) || !value.temp.startsWith(EDIT_PREFIX)) return null
        if (!simpleName(value.backup) || !value.backup.startsWith(BACKUP_PREFIX)) return null
        if (typeof value.baseHash !== 'string' || !value.baseHash) return null
        return { v: 1, final: value.final, temp: value.temp, backup: value.backup, phase: value.phase, baseHash: value.baseHash, ...(value.retainBackup === true && {retainBackup: true as const}) }
    } catch { return null }
}

type RenameHop = { v: 2; from: string; temp: string; to: string; dev: string; ino: string; parentDev: string; parentIno: string }

function parseRenameHop(raw: string): RenameHop | null {
    try {
        const value = JSON.parse(raw) as Partial<RenameHop>
        if (value.v !== 2 || !simpleName(value.from) || !simpleName(value.to) || !simpleName(value.temp)) return null
        if (!value.temp.startsWith(RENAME_PREFIX) || value.temp.endsWith('.json') || value.from === value.to || reservedName(value.from) || reservedName(value.to)) return null
        for (const id of [value.dev, value.ino, value.parentDev, value.parentIno]) if (typeof id !== 'string' || !/^\d{1,24}$/.test(id)) return null
        return { v: 2, from: value.from, temp: value.temp, to: value.to, dev: value.dev!, ino: value.ino!, parentDev: value.parentDev!, parentIno: value.parentIno! }
    } catch { return null }
}

/** Recover only the journal's original inode in its original pinned parent. A destination or
 * source arriving during recovery is never replaced, and an unknown temporary entry is untouched. */
async function recoverRenameHops(directory: string, pinned: string, names: string[], assertUnmoved: () => Promise<void>) {
    for (const name of names) {
        if (!name.startsWith(RENAME_PREFIX) || !name.endsWith('.json') || claimed(directory, name)) continue
        const journalPath = join(pinned, name)
        const journalIdentity = await fileStat(journalPath)
        const raw = await readRecoveryText(join(pinned, name), 4096)
        await assertUnmoved()
        const hop = raw === null ? null : parseRenameHop(raw)
        if (!hop || [hop.from, hop.temp, hop.to].some(entry => claimed(directory, entry))) continue
        const parent = { dev: BigInt(hop.parentDev), ino: BigInt(hop.parentIno) }
        if (!sameFile(await fileStat(directory), parent)) continue
        const identity = { dev: BigInt(hop.dev), ino: BigInt(hop.ino) }
        const tempPath = join(pinned, hop.temp)
        const toPath = join(pinned, hop.to)
        const fromPath = join(pinned, hop.from)
        const tempStat = await fileStat(tempPath)
        let recoveredName: string | undefined
        await assertUnmoved()
        if (tempStat && (tempStat.isSymbolicLink() || (!tempStat.isFile() && !tempStat.isDirectory()))) continue
        if (tempStat && !sameFile(tempStat, identity)) {
            // A writer replaced the source between native preflight and its rename, and a
            // crash prevented the caller from surfacing that staged replacement. It cannot
            // complete the original rename: preserve its actual inode under a visible name.
            recoveredName = `rename-recovery-${randomBytes(12).toString('hex')}${tempStat.isFile() ? hop.from.match(/\.[^.]+$/)?.[0] ?? '' : ''}`
            await assertUnmoved()
            await renameWithoutReplace(directory, parent, hop.temp, tempStat, recoveredName)
        } else if (tempStat) {
            try {
                await assertUnmoved()
                await renameWithoutReplace(directory, parent, hop.temp, identity, hop.to)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                // A newer destination wins. Return our staged entry to its old name if free;
                // otherwise keep both entries and the journal for a later explicit review.
                await assertUnmoved()
                try { await renameWithoutReplace(directory, parent, hop.temp, identity, hop.from) }
                catch (rollback) {
                    if ((rollback as NodeJS.ErrnoException).code !== 'EEXIST') throw rollback
                    recoveredName = `rename-recovery-${randomBytes(12).toString('hex')}${tempStat.isFile() ? hop.from.match(/\.[^.]+$/)?.[0] ?? '' : ''}`
                    await assertUnmoved()
                    await renameWithoutReplace(directory, parent, hop.temp, identity, recoveredName)
                }
            }
        }
        await assertUnmoved()
        if (!await fileStat(tempPath) && (recoveredName || sameFile(await fileStat(toPath), identity) || sameFile(await fileStat(fromPath), identity))) {
            await assertUnmoved()
            if (sameFile(journalIdentity, await fileStat(journalPath))) { await assertUnmoved(); await removeName(journalPath) }
        }
        if (recoveredName) throw new DesktopHttpError(409, `An interrupted rename met newer files. All versions were kept; refresh Files to find “${recoveredName}”.`)
    }
}

async function readRecoveryText(path: string, limit: number): Promise<string | null> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        .catch(error => { if (missing(error) || (error as NodeJS.ErrnoException).code === 'ELOOP') return null; throw error })
    if (!handle) return null
    try {
        const before = await handle.stat()
        if (!before.isFile() || before.size > limit) return null
        const bytes = Buffer.alloc(before.size)
        let length = 0
        while (length < bytes.length) {
            const read = await handle.read(bytes, length, bytes.length - length, length)
            if (!read.bytesRead) break
            length += read.bytesRead
        }
        const after = await handle.stat()
        if (length !== before.size || after.size !== before.size || after.ctimeMs !== before.ctimeMs) return null
        return editableText(bytes)
    } finally { await handle.close() }
}

/** Call only within the roster queue; recovery itself mutates the folder. `workspaceRoot` is the
 * coworker's canonical workspace. Delete recovery refuses to resume when this folder no longer
 * belongs to that workspace, so a relocated parent is not cleaned up inside another coworker. */
async function recoverInterruptedCoworkerEdits(directory: string, workspaceRoot?: string): Promise<InterruptedCoworkerRecovery[]> {
    const handle = await openResolved(directory, true).catch(error => { if (missing(error)) return null; throw error })
    if (!handle) return []
    try {
        const pinned = await pinnedDirectory(handle)
        const assertUnmoved = async () => {
            const [opened, listed, actual] = await Promise.all([
                handle.stat({ bigint: true }),
                lstat(directory, { bigint: true }).catch(() => null),
                realpath(directory).catch(() => null),
            ])
            if (!sameFile(opened, listed) || actual !== directory) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
        }
        await assertUnmoved()
        const rootInfo = workspaceRoot ? await fileStat(workspaceRoot) : null
        const rootIdentity = workspaceRoot && rootInfo?.isDirectory() ? { path: workspaceRoot, dev: rootInfo.dev, ino: rootInfo.ino } : null
        return await recoverInDirectory(directory, pinned, assertUnmoved, rootIdentity)
    } finally { await handle.close() }
}

/** A name this process is publishing is left alone. Every mutation is safe to repeat. */
async function recoverInDirectory(directory: string, pinned: string, assertUnmoved: () => Promise<void>, workspaceRoot: (FileIdentity & { path: string }) | null): Promise<InterruptedCoworkerRecovery[]> {
    const recoveries: InterruptedCoworkerRecovery[] = []
    let names: string[]
    try { names = await readdir(pinned) } catch (error) { if (missing(error)) return recoveries; throw error }
    await recoverRenameHops(directory, pinned, names, assertUnmoved)
    await assertUnmoved()
    const journals = names.filter(name => name.startsWith(PUBLISH_PREFIX))
    const referenced = new Set<string>()
    for (const journalName of journals) {
        const journalPath = join(pinned, journalName)
        const raw = await readRecoveryText(journalPath, 16 * 1024)
        await assertUnmoved()
        const journal = raw === null ? null : parseJournal(raw)
        if (!journal) continue
        referenced.add(journal.temp)
        referenced.add(journal.backup)
        if ([journalName, journal.final, journal.temp, journal.backup].some(name => claimed(directory, name))) continue
        const finalPath = join(pinned, journal.final)
        const tempPath = join(pinned, journal.temp)
        const backupPath = join(pinned, journal.backup)
        const [finalStat, tempStat, backupStat] = await Promise.all([fileStat(finalPath), fileStat(tempPath), fileStat(backupPath)])
        await assertUnmoved()
        if (finalStat && !finalStat.isFile()) continue
        const draftIsPublished = !!tempStat?.isFile() && sameFile(finalStat, tempStat) && !sameFile(finalStat, backupStat)
        if (journal.phase === 'linked') {
            if (!finalStat && backupStat?.isFile()) {
                try { await link(backupPath, finalPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
            }
        } else if (draftIsPublished && backupStat?.isFile()) {
            if (finalStat) await retireName(finalPath, finalStat)
            try { await link(backupPath, finalPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        } else if (!finalStat && backupStat?.isFile()) {
            try { await link(backupPath, finalPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        }
        const kept = await fileStat(finalPath)
        if (journal.retainBackup) {
            // Only remove an extra name when the displaced inode remains at the final name.
            // Otherwise it stays available even to a writer that opens it after recovery.
            if (backupStat && sameFile(kept, backupStat)) await retireName(backupPath, backupStat)
            if (tempStat && kept && !sameFile(tempStat, kept)) {
                // A refused/interrupted proposal remains inspectable too. This reserved name is
                // included in the tool's bounded backup budget and is not orphan-temp cleanup.
                const retainedDraft = join(pinned, `.rerun-backup-draft-${journal.temp.slice(EDIT_PREFIX.length)}`)
                try { await link(tempPath, retainedDraft) }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !sameFile(await fileStat(retainedDraft), tempStat)) throw error
                }
            }
            if (tempStat && kept) await retireName(tempPath, tempStat)
            if (kept || !backupStat) await removeName(journalPath)
            continue
        }
        if (backupStat?.isFile() && kept) {
            // A writer can close after changing the displaced inode. Check for held handles
            // first, then compare its final bytes before retiring the last backup name.
            const held = await inodeMayBeHeld(backupPath)
            const text = await readRecoveryText(backupPath, EDIT_BYTES)
            await assertUnmoved()
            if (held || text === null || hashText(text) !== journal.baseHash) {
                if (journal.phase === 'linked' && sameFile(finalStat, tempStat)) {
                    await retireName(finalPath, finalStat!)
                    await link(backupPath, finalPath)
                }
                recoveries.push({ final: journal.final, recovery: await recoveryLinks(pinned, journal.final, tempPath, backupPath) })
            }
            await retireName(backupPath, backupStat)
        }
        if (tempStat && kept) await retireName(tempPath, tempStat)
        if (kept || !backupStat) await removeName(journalPath)
    }
    let again: string[]
    try { again = await readdir(pinned) } catch (error) { if (missing(error)) return recoveries; throw error }
    await assertUnmoved()
    for (const name of again) {
        if (!name.startsWith(EDIT_PREFIX) || referenced.has(name) || claimed(directory, name)) continue
        if (again.some(entry => entry.startsWith(PUBLISH_PREFIX))) continue
        const path = join(pinned, name)
        const info = await fileStat(path)
        if (info) await retireName(path, info)
    }
    await assertUnmoved()
    await recoverDeleteJournals(directory, pinned, assertUnmoved, workspaceRoot)
    await assertUnmoved()
    return recoveries
}

const saveLocks = new Map<string, Promise<void>>()

async function withSaveLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = saveLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    saveLocks.set(key, tail)
    await previous
    try { return await run() } finally {
        release()
        if (saveLocks.get(key) === tail) saveLocks.delete(key)
    }
}

/**
 * Publish a draft without giving another coworker the text or dropping a writer who won the race.
 * `rename` can replace a name atomically and `renamex_np(RENAME_SWAP)` can exchange two names, but
 * neither call can see a writer that already holds the file open, or a parent that moves during the
 * call. A path check before `link` is too early for that. The previous bytes stay under a hidden
 * backup until the open folder and those bytes are checked again. A held or uncertain inode gets
 * visible recovery links before retirement, and retirement verifies identity after an atomic move.
 * If the app stops while the normal name is aside, the next list or read of the folder puts the
 * backup back, or keeps the name when the draft was already committed. A hidden draft is not a
 * second copy to edit.
 */
export async function saveCoworkerFile(runtime: DesktopRuntime, agentId: string, path: string, content: string, baseHash: string, identity?: string, publication?: PrivateToolPublication): Promise<SaveCoworkerFileResult> {
    return withCoworkerFiles(runtime, agentId, async () => {
        await publication?.beforePublish()
        return saveFile(runtime, agentId, path, content, baseHash, identity, publication)
    })
}

async function saveFile(runtime: DesktopRuntime, agentId: string, path: string, content: string, baseHash: string, identity?: string, publication?: PrivateToolPublication): Promise<SaveCoworkerFileResult> {
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.byteLength > EDIT_BYTES) throw new DesktopHttpError(413, 'Files over 256 KB can’t be edited here.')
    if (editableText(bytes) !== content) throw new DesktopHttpError(415, 'Only UTF-8 text can be saved here.')
    const workspace=await coworkerWorkspace(runtime,agentId)
    if(publication)await assertPrivateToolLocation(workspace,path,true)
    const { root, target, rel } = await containedPath(workspace, path)
    if(publication && target!==join(/* turbopackIgnore: true */ root ?? '',path))throw new DesktopHttpError(400,'Private file tools cannot follow symlinks.')
    const name = basename(rel)
    if (publication && !PRIVATE_TOOL_EDITABLE.test(name)) throw new DesktopHttpError(415, 'Only .txt and .md files can be edited here.')
    if (!canEditCoworkerFileName(name) || target && !canEditCoworkerFileName(basename(target))) {
        throw new DesktopHttpError(415, 'Only visible UTF-8 text files can be edited here.')
    }
    if (!root || !target) throw new DesktopHttpError(404, 'File not found')
    if (!baseHash) throw new DesktopHttpError(400, 'The opened file version is required for every save.')
    const outside = () => new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const folder = dirname(target)
    const finalName = basename(target)
    if (!inside(root, folder)) throw outside()
    return withSaveLock(target, async () => {
        await publication?.beforePublish()
        if (publication) {
            if (!publication.snapshot || publication.snapshot.target !== target) throw outside()
            await privateFileLocation(workspace, path)
            await assertPrivateSnapshot(publication.snapshot)
            await assertPrivateBackupBudget(publication.snapshot)
        }
        let savedIdentity: string | undefined
        const interrupted = publication ? undefined : (await recoverInterruptedCoworkerEdits(folder, root!)).find(item => item.final === finalName)
        claim(folder, finalName)
        try {
        const interruptedRecovery = interrupted ? {
            draft: rel.slice(0, -finalName.length) + interrupted.recovery.draft,
            external: rel.slice(0, -finalName.length) + interrupted.recovery.external,
        } : undefined
        let dir: FileHandle
        try { dir = await openResolved(folder, true) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DesktopHttpError(404, 'File not found')
            throw error
        }
        try {
            const pinned = await pinnedDirectory(dir)
            const assertFolderUnmoved = async () => {
                if (publication?.snapshot) await assertPrivateDirectories(publication.snapshot)
                const [opened, listed, actual] = await Promise.all([
                    dir.stat({ bigint: true }),
                    lstat(folder, { bigint: true }).catch(() => null),
                    realpath(folder).catch(() => null),
                ])
                if (!listed || !actual || actual !== folder || !inside(root, actual) || opened.dev !== listed.dev || opened.ino !== listed.ino) throw outside()
            }
            const readCurrent = async (fileName = finalName) => {
                if (publication) {
                    await assertFolderUnmoved()
                    const current = await readPrivateTextAt(join(/* turbopackIgnore: true */ folder, fileName)).catch(error => { if (missing(error)) return null; throw error })
                    await assertFolderUnmoved()
                    return current
                }
                const info = await lstat(join(pinned, fileName)).catch(error => { if (missing(error)) return null; throw error })
                if (!info) return null
                if (!info.isFile()) throw outside()
                const handle = await open(join(pinned, fileName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
                try {
                    const opened = await handle.stat()
                    if (!opened.isFile()) throw outside()
                    if (opened.size > EDIT_BYTES) throw new DesktopHttpError(413, 'Files over 256 KB can’t be edited here.')
                    const buffer = Buffer.alloc(Math.min(opened.size, EDIT_BYTES + 1))
                    let bytesRead = 0
                    while (bytesRead < buffer.length) {
                        const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
                        if (!read.bytesRead) break
                        bytesRead += read.bytesRead
                    }
                    if (bytesRead > EDIT_BYTES) throw new DesktopHttpError(413, 'Files over 256 KB can’t be edited here.')
                    const after = await handle.stat()
                    if (!after.isFile() || after.size > EDIT_BYTES) throw new DesktopHttpError(413, 'Files over 256 KB can’t be edited here.')
                    const text = editableText(buffer.subarray(0, bytesRead))
                    if (text === null) throw new DesktopHttpError(415, 'This file is not UTF-8 text, so it can’t be edited here.')
                    const identified = await handle.stat({ bigint: true })
                    return { content: text, hash: hashText(text), mode: opened.mode & 0o777, identity: `${identified.dev}:${identified.ino}` }
                } finally { await handle.close() }
            }
            const assertPrivateDisplaced = async (fileName: string) => {
                if (!publication?.snapshot) return
                const current = await readPrivateTextAt(join(/* turbopackIgnore: true */ folder, fileName))
                await assertFolderUnmoved()
                const expected = publication.snapshot
                // Rename changes ctime, but it must not change the data, owner, link count,
                // inode or mtime of the complete snapshot used for the exact-string edit.
                if (current.identity !== expected.identity || current.hash !== expected.hash ||
                    current.mtime !== expected.mtime || current.size !== expected.size) throw outside()
            }
            // Folder identity is checked after the read. A moved directory is rejected with no file bytes.
            const check = async () => {
                const current = await readCurrent()
                await assertFolderUnmoved()
                if (!current) throw new DesktopHttpError(404, 'This file was moved or deleted since you opened it.')
                // Equal bytes do not make a replacement at the old path the editor's original file.
                // Require a fresh preview even if the renamed inode was subsequently deleted.
                if (identity && current.identity !== identity) {
                    throw new CoworkerFileConflict({ content: current.content, hash: current.hash, identity: current.identity }, interruptedRecovery, true)
                }
                if (current.hash !== baseHash) throw new CoworkerFileConflict({ content: current.content, hash: current.hash, identity: current.identity }, interruptedRecovery)
                if (publication?.snapshot) await assertPrivateSnapshot(publication.snapshot)
                return current
            }
            const { mode } = await check()
            const tempName = `.rerun-edit-${randomBytes(12).toString('hex')}`
            const backupName = `.rerun-backup-${randomBytes(12).toString('hex')}`
            const journalName = `.rerun-publish-${randomBytes(12).toString('hex')}.json`
            claim(folder, tempName)
            claim(folder, backupName)
            claim(folder, journalName)
            const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
            try {
            let handle: FileHandle
            try {
                handle = process.platform === 'darwin'
                    ? await open(join(folder, tempName), flags | 0x20000000, mode)
                    : await open(`${pinned}/${tempName}`, flags | constants.O_NOFOLLOW, mode)
            } catch (error) {
                if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw outside()
                throw error
            }
            const tempPath = join(pinned, tempName)
            const backupPath = join(pinned, backupName)
            const finalPath = join(pinned, finalName)
            const journalPath = join(pinned, journalName)
            let backupCreated = false
            let backupIdentity: FileIdentity | null = null
            let published = false
            let committed = false
            let keepWinner = false
            let recoveryCreated = false
            let publishedDev: bigint | null = null
            let publishedIno: bigint | null = null
            const openHidden = (hiddenName: string, openFlags: number, openMode: number) => process.platform === 'darwin'
                ? open(join(folder, hiddenName), openFlags | 0x20000000, openMode)
                : open(`${pinned}/${hiddenName}`, openFlags | constants.O_NOFOLLOW, openMode)
            const writeJournal = async (phase: 'prepared' | 'linked') => {
                const openFlags = phase === 'prepared'
                    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
                    : constants.O_WRONLY | constants.O_TRUNC
                const journal = await openHidden(journalName, openFlags, 0o600)
                try {
                    await journal.writeFile(JSON.stringify({ v: 1, final: finalName, temp: tempName, backup: backupName, phase, baseHash, ...(publication && {retainBackup: true}) }))
                    await journal.sync()
                } finally { await journal.close() }
            }
            const preserveRecovery = async (): Promise<CoworkerFileRecovery> => {
                const linked = await recoveryLinks(pinned, finalName, tempPath, backupPath)
                recoveryCreated = true
                const prefix = rel.slice(0, -finalName.length)
                return { draft: prefix + linked.draft, external: prefix + linked.external }
            }
            const retireBackup = async (currentName = backupName) => {
                if (!backupCreated) return
                if (!backupIdentity) throw new DesktopHttpError(404, 'This file was moved or deleted since you opened it.')
                if (publication) {
                    // Keep the old inode after commit or when another writer won. During rollback
                    // its final name is restored, so only the redundant backup name is retired.
                    if (sameFile(await fileStat(finalPath), backupIdentity)) await retireName(backupPath, backupIdentity)
                    backupCreated = false
                    return
                }
                if (await inodeMayBeHeld(backupPath)) {
                    const latest = await readCurrent(currentName)
                    await assertFolderUnmoved()
                    const recovery = await preserveRecovery()
                    throw new CoworkerFileConflict(latest ? { content: latest.content, hash: latest.hash } : null, recovery)
                }
                const displaced = await readCurrent(backupName)
                await assertFolderUnmoved()
                if (!displaced || displaced.hash !== baseHash) {
                    const latest = currentName === backupName ? displaced : await readCurrent(currentName)
                    await assertFolderUnmoved()
                    const recovery = await preserveRecovery()
                    throw new CoworkerFileConflict(latest ? { content: latest.content, hash: latest.hash } : null, recovery)
                }
                if (!await retireName(backupPath, backupIdentity)) {
                    const competing = await readCurrent(currentName)
                    await assertFolderUnmoved()
                    const recovery = await preserveRecovery()
                    throw new CoworkerFileConflict(competing ? { content: competing.content, hash: competing.hash } : null, recovery)
                }
                backupCreated = false
            }
            // Drop our draft only. A different inode at the final name is the winner and stays.
            const restoreBackup = async () => {
                if (!keepWinner && published && publishedDev !== null && publishedIno !== null) {
                    const drafted = await fileStat(finalPath)
                    if (drafted && drafted.dev === publishedDev && drafted.ino === publishedIno) await removeName(finalPath)
                    published = false
                }
                if (keepWinner) {
                    if (!recoveryCreated && (await fileStat(finalPath))?.isFile()) await retireBackup(finalName)
                    backupCreated = false
                    return
                }
                if (!backupCreated) return
                try {
                    await link(backupPath, finalPath)
                    if (!recoveryCreated) await retireBackup()
                    backupCreated = false
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                    if ((await fileStat(finalPath))?.isFile()) {
                        if (!recoveryCreated) await retireBackup()
                        backupCreated = false
                    }
                }
            }
            try {
                try {
                    const [opened, listed] = await Promise.all([handle.stat({ bigint: true }), lstat(tempPath, { bigint: true })])
                    if (opened.ino !== listed.ino || opened.dev !== listed.dev) throw outside()
                    await handle.writeFile(bytes)
                    await handle.sync()
                } finally {
                    await handle.close()
                }
                crashPublish('temp')
                await check()
                await assertFolderUnmoved()
                await writeJournal('prepared')
                crashPublish('prepared')
                const displaced = await fileStat(finalPath)
                if (!displaced) throw new DesktopHttpError(404, 'This file was moved or deleted since you opened it.')
                await publication?.beforePublish()
                if (publication?.snapshot) {
                    await assertPrivateSnapshot(publication.snapshot)
                    await assertFolderUnmoved()
                }
                try { await rename(finalPath, backupPath) } catch (error) {
                    if (missing(error)) throw new DesktopHttpError(404, 'This file was moved or deleted since you opened it.')
                    throw error
                }
                backupCreated = true
                backupIdentity = displaced
                crashPublish('renamed')
                await assertFolderUnmoved()
                const preserved = await readCurrent(backupName)
                await assertFolderUnmoved()
                if (!preserved) throw new DesktopHttpError(404, 'This file was moved or deleted since you opened it.')
                if (preserved.hash !== baseHash || (identity && preserved.identity !== identity)) throw new CoworkerFileConflict({ content: preserved.content, hash: preserved.hash })
                await publication?.beforePublish()
                if (publication) { await assertFolderUnmoved(); await assertPrivateDisplaced(backupName) }
                try { await link(tempPath, finalPath) } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                    keepWinner = true
                    const competing = await readCurrent()
                    await assertFolderUnmoved()
                    if (!competing) throw new DesktopHttpError(404, 'This file was moved or deleted since you opened it.')
                    throw new CoworkerFileConflict({ content: competing.content, hash: competing.hash })
                }
                const linked = await fileStat(finalPath)
                const drafted = await fileStat(tempPath)
                if (!linked || !drafted || linked.dev !== drafted.dev || linked.ino !== drafted.ino) {
                    keepWinner = true
                    const competing = await readCurrent()
                    await assertFolderUnmoved()
                    if (!competing) throw new DesktopHttpError(404, 'This file was moved or deleted since you opened it.')
                    throw new CoworkerFileConflict({ content: competing.content, hash: competing.hash })
                }
                published = true
                publishedDev = linked.dev
                publishedIno = linked.ino
                savedIdentity = `${linked.dev}:${linked.ino}`
                crashPublish('uncommitted')
                await assertFolderUnmoved()
                const after = await readCurrent(backupName)
                await assertFolderUnmoved()
                if (!after || after.hash !== baseHash) throw new CoworkerFileConflict(after ? { content: after.content, hash: after.hash } : null)
                await publication?.beforePublish()
                if (publication) { await assertFolderUnmoved(); await assertPrivateDisplaced(backupName) }
                await writeJournal('linked')
                crashPublish('linked')
                await retireBackup()
                committed = true
                await removeName(tempPath)
                await removeName(journalPath)
            } catch (error) {
                if (!committed) {
                    await restoreBackup()
                    await removeName(journalPath)
                }
                throw error
            } finally {
                if (!committed) await removeName(tempPath)
            }
            } finally {
                unclaim(folder, tempName)
                unclaim(folder, backupName)
                unclaim(folder, journalName)
            }
        } finally {
            await dir.close()
        }
        return { path: rel, hash: hashText(content), size: bytes.byteLength, identity: savedIdentity }
        } finally {
            unclaim(folder, finalName)
        }
    })
}

/** Rename through an identity-bound journal and exclusive native moves. The staged entry is
 * recoverable after a restart, including the case-only rename of a directory on APFS. */
export async function renameCoworkerFile(runtime: DesktopRuntime, agentId: string, path: string, nextName: string): Promise<{ path: string; name: string }> {
    return withCoworkerFiles(runtime, agentId, () => renameEntry(runtime, agentId, path, nextName))
}

async function renameEntry(runtime: DesktopRuntime, agentId: string, path: string, nextName: string): Promise<{ path: string; name: string }> {
    if (!simpleName(nextName) || /[\r\n]/.test(nextName) || nextName.length > 255 || Buffer.byteLength(nextName) > 255) throw new DesktopHttpError(400, 'Choose a new name in this folder. A rename can’t include a path.')
    if (reservedName(nextName)) throw new DesktopHttpError(400, 'That name can’t be changed.')
    const workspace = await coworkerWorkspace(runtime, agentId)
    const located = await containedPath(workspace, path)
    if (!located.rel) throw new DesktopHttpError(400, 'Choose a file or folder to rename.')
    const slash = located.rel.lastIndexOf('/')
    const parentRel = slash === -1 ? '' : located.rel.slice(0, slash)
    const sourceName = located.rel.slice(slash + 1)
    if (!simpleName(sourceName) || reservedName(sourceName)) throw new DesktopHttpError(400, 'That name can’t be changed.')
    const parentPath = await containedPath(workspace, parentRel)
    if (!parentPath.root || !parentPath.target) throw new DesktopHttpError(404, `“${sourceName}” was not found.`)
    const folder = parentPath.target
    const root = parentPath.root
    const outside = () => new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const kept = () => new DesktopHttpError(409, `This folder already has “${nextName}”. It was left unchanged.`)
    await recoverInterruptedCoworkerEdits(folder, root)
    const dir = await openResolved(folder, true)
    try {
        const pinned = await pinnedDirectory(dir)
        const parent = await dir.stat({ bigint: true })
        const assertUnmoved = async () => {
            const [listed, actual] = await Promise.all([fileStat(folder), realpath(folder).catch(() => null)])
            if (!sameFile(parent, listed) || actual !== folder || !inside(root, actual)) throw outside()
        }
        const move = async (from: string, to: string, identity: FileIdentity) => {
            await assertUnmoved()
            await renameWithoutReplace(folder, parent, from, identity, to)
            await assertUnmoved()
        }
        await assertUnmoved()
        const source = await fileStat(join(pinned, sourceName))
        if (!source) throw new DesktopHttpError(404, `“${sourceName}” was not found.`)
        if (source.isSymbolicLink() || (!source.isFile() && !source.isDirectory())) throw new DesktopHttpError(400, 'Choose a file or folder, not a symlink.')
        if (claimed(folder, sourceName) || claimed(folder, nextName)) throw new DesktopHttpError(409, 'This file is being saved. Try the rename again once that finishes.')
        if (sourceName === nextName) return { path: located.rel, name: sourceName }
        const names = await readdir(pinned)
        const destination = await fileStat(join(pinned, nextName))
        // A case/Unicode alias of this one directory entry is allowed; another hard link is
        // still an occupied destination, even though it happens to have the same inode.
        if (destination && (!sameFile(destination, source) || names.includes(nextName))) throw kept()
        const token = randomBytes(12).toString('hex')
        const temp = `${RENAME_PREFIX}${token}`
        const journalName = `${RENAME_PREFIX}${token}.json`
        const journalPath = join(pinned, journalName)
        const hop: RenameHop = { v: 2, from: sourceName, temp, to: nextName, dev: String(source.dev), ino: String(source.ino), parentDev: String(parent.dev), parentIno: String(parent.ino) }
        let journalIdentity: FileIdentity | null = null
        const cleanJournal = async () => {
            if (await fileStat(join(pinned, temp))) return
            await assertUnmoved()
            if (sameFile(journalIdentity, await fileStat(journalPath))) { await assertUnmoved(); await removeName(journalPath) }
        }
        for (const name of [sourceName, nextName, temp, journalName]) claim(folder, name)
        try {
            await assertUnmoved()
            const journal = await open(journalPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
            try {
                journalIdentity = await journal.stat({ bigint: true })
                await assertUnmoved()
                await journal.writeFile(JSON.stringify(hop))
                await assertUnmoved()
                await journal.sync()
            } finally { await journal.close() }
            await move(sourceName, temp, source)
            await move(temp, nextName, source)
            await assertUnmoved()
            const acceptable = (name: string) => name === nextName || name === nextName.normalize('NFC') || name === nextName.normalize('NFD')
            const catalog = (await readdir(pinned)).find(acceptable)
            if (!catalog || !sameFile(await fileStat(join(pinned, catalog)), source)) throw Object.assign(new Error('Entry changed during rename'), { code: 'ESTALE' })
            await cleanJournal()
            return { path: parentRel ? `${parentRel}/${catalog}` : catalog, name: catalog }
        } catch (error) {
            // Ownership loss forbids further mutations. Keep the journal and staged bytes.
            await assertUnmoved()
            const staged = await fileStat(join(pinned, temp))
            let recovery: string | undefined
            if (staged && !staged.isSymbolicLink() && (staged.isFile() || staged.isDirectory())) {
                try { await move(temp, sourceName, staged) }
                catch (rollback) {
                    if ((rollback as NodeJS.ErrnoException).code !== 'EEXIST') throw rollback
                    // Both normal names now belong to newer arrivals. Preserve the staged
                    // entry under a visible name instead of hiding or overwriting any version.
                    const suffix = source.isDirectory() ? '' : sourceName.match(/\.[^.]+$/)?.[0] ?? ''
                    recovery = `rename-recovery-${token}${suffix}`
                    await move(temp, recovery, staged)
                }
            }
            if ((error as NodeJS.ErrnoException).code !== 'EIO') await cleanJournal()
            if (recovery) throw new DesktopHttpError(409, `The file changed during rename. All versions were kept; refresh Files to find “${recovery}”.`)
            if (error instanceof DesktopHttpError) throw error
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'EEXIST') throw kept()
            if (code === 'ESTALE') throw new DesktopHttpError(409, 'This entry moved or changed during rename. Refresh Files before trying again.')
            if (code === 'ENOENT') throw new DesktopHttpError(404, `“${sourceName}” was not found.`)
            if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EXDEV') throw outside()
            throw error
        } finally {
            for (const name of [sourceName, nextName, temp, journalName]) unclaim(folder, name)
        }
    } finally { await dir.close() }
}

const MAX_DELETE_NODES = 10_000
const MAX_DELETE_DEPTH = 64
const DIRECTORY_OPEN = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
type DeleteNode = { name: string; dev: string; ino: string; type: 'file' | 'dir'; children?: DeleteNode[] }
type DeleteJournal = { v: 1; name: string; dev: string; ino: string; parentDev: string; parentIno: string; workspaceDev: string; workspaceIno: string; nodes?: DeleteNode[] }
type DeleteWorkspace = FileIdentity & { path: string }
type DeleteStage = Omit<DeleteJournal, 'v' | 'nodes'> & { v: 2; kind: 'stage'; type: 'file' | 'dir'; temp: string; recovery: string }

function idText(value: bigint): string {
    const text = value.toString()
    if (!/^\d{1,24}$/.test(text)) throw new DesktopHttpError(409, 'This entry changed during delete. It was left unchanged.')
    return text
}
const parseId = (value: unknown): string | null => typeof value === 'string' && /^\d{1,24}$/.test(value) ? value : null
const asIdentity = (dev: string, ino: string): FileIdentity => ({ dev: BigInt(dev), ino: BigInt(ino) })

function parseDeleteNode(value: unknown, depth: number): DeleteNode | null {
    if (depth > MAX_DELETE_DEPTH || !value || typeof value !== 'object') return null
    const node = value as Partial<DeleteNode>
    const dev = parseId(node.dev)
    const ino = parseId(node.ino)
    if (!simpleName(node.name) || reservedName(node.name) || !dev || !ino) return null
    if (node.type === 'file') return node.children === undefined ? { name: node.name, dev, ino, type: 'file' } : null
    if (node.type !== 'dir' || !Array.isArray(node.children)) return null
    const children: DeleteNode[] = []
    for (const child of node.children) {
        const parsed = parseDeleteNode(child, depth + 1)
        if (!parsed) return null
        children.push(parsed)
    }
    return { name: node.name, dev, ino, type: 'dir', children }
}

function parseDeleteJournal(raw: string): DeleteJournal | null {
    try {
        const value = JSON.parse(raw) as Partial<DeleteJournal>
        if (value.v !== 1 || !simpleName(value.name) || reservedName(value.name)) return null
        const dev = parseId(value.dev)
        const ino = parseId(value.ino)
        const parentDev = parseId(value.parentDev)
        const parentIno = parseId(value.parentIno)
        const workspaceDev = parseId(value.workspaceDev)
        const workspaceIno = parseId(value.workspaceIno)
        if (!dev || !ino || !parentDev || !parentIno || !workspaceDev || !workspaceIno) return null
        if (value.nodes === undefined) return { v: 1, name: value.name, dev, ino, parentDev, parentIno, workspaceDev, workspaceIno }
        if (!Array.isArray(value.nodes)) return null
        const nodes: DeleteNode[] = []
        for (const node of value.nodes) {
            const parsed = parseDeleteNode(node, 1)
            if (!parsed) return null
            nodes.push(parsed)
        }
        return { v: 1, name: value.name, dev, ino, parentDev, parentIno, workspaceDev, workspaceIno, nodes }
    } catch { return null }
}

function parseDeleteStage(raw: string): DeleteStage | null {
    try {
        const value = JSON.parse(raw) as DeleteStage
        if (value.v !== 2 || value.kind !== 'stage' || !['file', 'dir'].includes(value.type) ||
            !simpleName(value.name) || reservedName(value.name) || !/^\.rerun-delete-[a-f0-9]{24}$/.test(value.temp) ||
            !simpleName(value.recovery) || !value.recovery.startsWith('delete-recovery-') || reservedName(value.recovery)) return null
        if (![value.dev, value.ino, value.parentDev, value.parentIno, value.workspaceDev, value.workspaceIno].every(parseId)) return null
        return value
    } catch { return null }
}

function deleteDirectoryGuard(canonical: string, identity: FileIdentity, root: DeleteWorkspace, ancestor: () => Promise<void>) {
    return async () => {
        await ancestor()
        const [listed, actual, workspace, workspaceActual] = await Promise.all([
            fileStat(canonical), realpath(canonical).catch(() => null), fileStat(root.path), realpath(root.path).catch(() => null),
        ])
        if (!listed?.isDirectory() || listed.isSymbolicLink() || !sameFile(listed, identity) || actual !== canonical || !inside(root.path, actual) ||
            !workspace?.isDirectory() || workspace.isSymbolicLink() || !sameFile(workspace, root) || workspaceActual !== root.path) {
            throw new DesktopHttpError(400, 'That folder moved outside this coworker’s workspace. Its remaining files were left unchanged.')
        }
    }
}

function assertDeleteHelper() {
    const helper = process.env.RERUN_DESKTOP_RENAME_HELPER
    if (!helper || !isAbsolute(helper)) throw new DesktopHttpError(503, 'The safe rename helper is unavailable. Reopen the app and try again.')
}

async function stagedFileRemains(canonicalDir: string, pinned: string, root: DeleteWorkspace, assertUnmoved: () => Promise<void>, depth = 0): Promise<boolean> {
    if (depth > MAX_DELETE_DEPTH) return true
    await assertUnmoved()
    let names: string[]
    try { names = await readdir(pinned) } catch (error) { if (missing(error)) return false; throw error }
    for (const name of names) {
        await assertUnmoved()
        if (!simpleName(name)) continue
        const info = await fileStat(join(pinned, name))
        if (!info) continue
        // An unexpected staged inode is still recovery data. Identity mismatch never makes
        // it safe to forget the intent, including legacy unrecorded private names.
        if (name.startsWith(DELETE_PREFIX) && !name.endsWith('.json')) return true
        if (name.startsWith(DELETE_PREFIX) && name.endsWith('.json')) {
            const raw = await readRecoveryText(join(pinned, name), 8 * 1024 * 1024)
            await assertUnmoved()
            if (raw && parseDeleteStage(raw)) return true
        }
        if (info.isDirectory() && !info.isSymbolicLink() && !reservedName(name)) {
            const child = await open(join(pinned, name), DIRECTORY_OPEN)
            try {
                const opened = await child.stat({ bigint: true })
                if (!sameFile(info, opened)) return true
                const canonical = join(canonicalDir, name)
                const guard = deleteDirectoryGuard(canonical, opened, root, assertUnmoved)
                await guard()
                if (await stagedFileRemains(canonical, await pinnedDirectory(child), root, guard, depth + 1)) return true
            } finally { await child.close() }
        }
    }
    return false
}

async function finishDeleteStage(canonicalDir: string, pinned: string, stage: DeleteStage, journalIdentity: FileIdentity, root: DeleteWorkspace, assertUnmoved: () => Promise<void>): Promise<'removed' | 'kept'> {
    const parent = asIdentity(stage.parentDev, stage.parentIno), expected = asIdentity(stage.dev, stage.ino)
    const journalName = stage.temp + '.json', tempPath = join(pinned, stage.temp)
    const preserve = async (actual: FileIdentity) => {
        let visible = stage.name
        await assertUnmoved()
        try { await renameWithoutReplace(canonicalDir, parent, stage.temp, actual, visible) }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            visible = stage.recovery
            await assertUnmoved()
            await renameWithoutReplace(canonicalDir, parent, stage.temp, actual, visible)
        }
        await assertUnmoved()
        if (await fileStat(tempPath)) throw new DesktopHttpError(409, 'Delete recovery is incomplete. The staged entry and its journal were kept.')
        await removeJournal(pinned, journalName, journalIdentity, assertUnmoved)
        throw new DesktopHttpError(409, `An entry changed during delete. All remaining versions were kept; refresh Files to find “${visible}”.`)
    }
    await assertUnmoved()
    const staged = await fileStat(tempPath)
    if (!staged) { await removeJournal(pinned, journalName, journalIdentity, assertUnmoved); return 'removed' }
    if (staged.isSymbolicLink() || (!staged.isFile() && !staged.isDirectory())) throw new DesktopHttpError(409, 'A staged entry changed type during delete. Its recovery journal was kept; review the folder before trying again.')
    if (!sameFile(staged, expected) || staged.isDirectory() !== (stage.type === 'dir')) return preserve(staged)
    if (stage.type === 'dir') {
        const child = await open(tempPath, DIRECTORY_OPEN)
        try {
            const opened = await child.stat({ bigint: true })
            if (!sameFile(opened, expected)) return preserve(opened)
            const guard = deleteDirectoryGuard(join(canonicalDir, stage.temp), opened, root, assertUnmoved)
            await guard()
            if ((await readdir(await pinnedDirectory(child))).length) return preserve(opened)
            await guard()
            try { await rmdir(tempPath) }
            catch (error) {
                if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return preserve(opened)
                if (!missing(error)) throw error
            }
        } finally { await child.close() }
    } else {
        await assertUnmoved()
        const current = await fileStat(tempPath)
        if (current && !sameFile(current, expected)) return preserve(current)
        await assertUnmoved()
        await unlink(tempPath).catch(error => { if (!missing(error)) throw error })
    }
    await assertUnmoved()
    const left = await fileStat(tempPath)
    if (left) {
        if (!sameFile(left, expected)) return preserve(left)
        return 'kept'
    }
    await removeJournal(pinned, journalName, journalIdentity, assertUnmoved)
    return 'removed'
}

async function recoverDeleteStages(canonicalDir: string, parent: FileIdentity, pinned: string, root: DeleteWorkspace, assertUnmoved: () => Promise<void>) {
    await assertUnmoved()
    for (const name of await readdir(pinned)) {
        if (!name.startsWith(DELETE_PREFIX) || !name.endsWith('.json') || claimed(canonicalDir, name)) continue
        const identity = await fileStat(join(pinned, name))
        const raw = await readRecoveryText(join(pinned, name), 8192)
        await assertUnmoved()
        const stage = raw && parseDeleteStage(raw)
        if (!stage || name !== stage.temp + '.json' || !identity || !sameFile(parent, asIdentity(stage.parentDev, stage.parentIno)) ||
            !sameFile(root, asIdentity(stage.workspaceDev, stage.workspaceIno)) || claimed(canonicalDir, stage.temp)) continue
        await finishDeleteStage(canonicalDir, pinned, stage, identity, root, assertUnmoved)
    }
}

async function stageAndRemove(canonicalDir: string, parent: FileIdentity, pinned: string, name: string, identity: FileIdentity, type: 'file' | 'dir', root: DeleteWorkspace, assertUnmoved: () => Promise<void>): Promise<'removed' | 'missing' | 'kept'> {
    await recoverDeleteStages(canonicalDir, parent, pinned, root, assertUnmoved)
    await assertUnmoved()
    const source = await fileStat(join(pinned, name))
    if (!source) return 'missing'
    if (!sameFile(source, identity) || source.isSymbolicLink() || (type === 'dir' ? !source.isDirectory() : !source.isFile())) return 'kept'
    const token = randomBytes(12).toString('hex'), temp = DELETE_PREFIX + token
    const stage: DeleteStage = { v: 2, kind: 'stage', type, name, temp, recovery: `delete-recovery-${token}${type === 'file' ? name.match(/\.[^.]+$/)?.[0] ?? '' : ''}`,
        dev: idText(identity.dev), ino: idText(identity.ino), parentDev: idText(parent.dev), parentIno: idText(parent.ino), workspaceDev: idText(root.dev), workspaceIno: idText(root.ino) }
    const journalName = temp + '.json'
    for (const entry of [temp, journalName]) claim(canonicalDir, entry)
    try {
        const receipt = await writeDeleteJournal(pinned, journalName, stage, assertUnmoved)
        await assertUnmoved()
        try { await renameWithoutReplace(canonicalDir, parent, name, identity, temp) }
        catch (error) {
            // ESTALE can mean a different source inode actually moved. Inspect the exact
            // journaled destination even on failure; never treat it as an untouched source.
            await assertUnmoved()
            if (await fileStat(join(pinned, temp))) await finishDeleteStage(canonicalDir, pinned, stage, receipt, root, assertUnmoved)
            else await removeJournal(pinned, journalName, receipt, assertUnmoved)
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ENOENT') return 'missing'
            if (['ESTALE', 'EEXIST', 'EINVAL'].includes(code ?? '')) return 'kept'
            throw error
        }
        if (process.env.RERUN_FILE_DELETE_CRASH === 'staged') throw new DesktopHttpError(500, 'Delete stopped after the entry was set aside.')
        return await finishDeleteStage(canonicalDir, pinned, stage, receipt, root, assertUnmoved)
    } finally { for (const entry of [temp, journalName]) unclaim(canonicalDir, entry) }
}

async function stageAndUnlinkFile(canonicalDir: string, parent: FileIdentity, pinned: string, name: string, identity: FileIdentity, root: DeleteWorkspace, assertUnmoved: () => Promise<void>) {
    return stageAndRemove(canonicalDir, parent, pinned, name, identity, 'file', root, assertUnmoved)
}

async function removeEmptyDirectory(canonicalDir: string, parent: FileIdentity, pinned: string, name: string, identity: FileIdentity, root: DeleteWorkspace, assertUnmoved: () => Promise<void>) {
    await recoverDeleteStages(canonicalDir, parent, pinned, root, assertUnmoved)
    await assertUnmoved()
    const info = await fileStat(join(pinned, name))
    if (!info) return 'missing'
    if (!sameFile(info, identity) || info.isSymbolicLink() || !info.isDirectory()) return 'kept'
    const child = await open(join(pinned, name), DIRECTORY_OPEN)
    try {
        const opened = await child.stat({ bigint: true })
        if (!sameFile(opened, identity)) return 'kept'
        const guard = deleteDirectoryGuard(join(canonicalDir, name), opened, root, assertUnmoved)
        await guard()
        if ((await readdir(await pinnedDirectory(child))).length) return 'kept'
        await guard()
        return await stageAndRemove(canonicalDir, parent, pinned, name, identity, 'dir', root, assertUnmoved)
    } finally { await child.close() }
}

async function deleteNodes(canonicalDir: string, parent: FileIdentity, pinned: string, nodes: DeleteNode[], root: DeleteWorkspace, assertUnmoved: () => Promise<void>): Promise<boolean> {
    await assertUnmoved()
    await recoverDeleteStages(canonicalDir, parent, pinned, root, assertUnmoved)
    let complete = true
    for (const node of nodes) {
        const identity = asIdentity(node.dev, node.ino)
        if (node.type === 'file') {
            if (await stageAndUnlinkFile(canonicalDir, parent, pinned, node.name, identity, root, assertUnmoved) === 'kept') complete = false
            continue
        }
        const info = await fileStat(join(pinned, node.name))
        if (!info) continue
        if (!sameFile(info, identity) || info.isSymbolicLink() || !info.isDirectory()) { complete = false; continue }
        const childCanonical = join(canonicalDir, node.name)
        const actual = await realpath(childCanonical).catch(() => null)
        if (actual !== childCanonical || !inside(root.path, actual)) { complete = false; continue }
        let child: FileHandle | null = null
        try {
            child = await open(join(pinned, node.name), DIRECTORY_OPEN)
            const opened = await child.stat({ bigint: true })
            if (!sameFile(opened, identity)) { complete = false; continue }
            const guard = deleteDirectoryGuard(childCanonical, opened, root, assertUnmoved)
            await guard()
            if (!await deleteNodes(childCanonical, { dev: opened.dev, ino: opened.ino }, await pinnedDirectory(child), node.children ?? [], root, guard)) complete = false
        } catch (error) {
            if (error instanceof DesktopHttpError) throw error
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENOENT') { complete = false; continue }
            throw error
        } finally { await child?.close() }
        if (await removeEmptyDirectory(canonicalDir, parent, pinned, node.name, identity, root, assertUnmoved) === 'kept') complete = false
    }
    return complete
}

async function inspectTree(pinned: string, canonicalDir: string, depth: number, counter: { n: number }, root: DeleteWorkspace, assertUnmoved: () => Promise<void>): Promise<DeleteNode[]> {
    if (depth > MAX_DELETE_DEPTH) throw new DesktopHttpError(409, 'This folder is too deep to delete safely. It was left unchanged.')
    await assertUnmoved()
    let names: string[]
    try { names = await readdir(pinned) } catch (error) { if (missing(error)) throw new DesktopHttpError(404, 'Folder not found'); throw error }
    const nodes: DeleteNode[] = []
    for (const name of names) {
        await assertUnmoved()
        if (++counter.n > MAX_DELETE_NODES) throw new DesktopHttpError(409, 'This folder is too large to delete safely. It was left unchanged.')
        if (!simpleName(name) || reservedName(name)) throw new DesktopHttpError(409, 'This folder contains a recovery file. It was left unchanged.')
        if (claimed(canonicalDir, name)) throw new DesktopHttpError(409, 'This file is being saved. Try the delete again once that finishes.')
        const info = await fileStat(join(pinned, name))
        if (!info) continue
        if (info.isSymbolicLink()) throw new DesktopHttpError(409, 'This folder contains a symlink. It was left unchanged.')
        if (info.isDirectory()) {
            let child: FileHandle
            try { child = await open(join(pinned, name), DIRECTORY_OPEN) }
            catch (error) {
                const code = (error as NodeJS.ErrnoException).code
                if (code === 'ELOOP' || code === 'ENOTDIR') throw new DesktopHttpError(409, 'This folder contains a symlink. It was left unchanged.')
                throw error
            }
            try {
                const opened = await child.stat({ bigint: true })
                if (!sameFile(opened, info)) throw new DesktopHttpError(409, 'This folder changed while it was checked. It was left unchanged.')
                const canonical = join(canonicalDir, name)
                const guard = deleteDirectoryGuard(canonical, opened, root, assertUnmoved)
                await guard()
                const children = await inspectTree(await pinnedDirectory(child), canonical, depth + 1, counter, root, guard)
                nodes.push({ name, dev: idText(info.dev), ino: idText(info.ino), type: 'dir', children })
            } finally { await child.close() }
        } else if (info.isFile()) nodes.push({ name, dev: idText(info.dev), ino: idText(info.ino), type: 'file' })
        else throw new DesktopHttpError(409, 'This folder contains an entry that is not a file or folder. It was left unchanged.')
    }
    return nodes
}

async function writeDeleteJournal(pinned: string, journalName: string, body: DeleteJournal | DeleteStage, assertUnmoved: () => Promise<void>): Promise<FileIdentity> {
    await assertUnmoved()
    const handle = await open(join(pinned, journalName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
        const identity = await handle.stat({ bigint: true })
        await assertUnmoved()
        await handle.writeFile(JSON.stringify(body))
        await assertUnmoved()
        await handle.sync()
        // The sidecar's directory entry must be durable before its recorded native move.
        await assertUnmoved()
        const parent = await open(pinned, DIRECTORY_OPEN)
        try { await assertUnmoved(); await parent.sync() } finally { await parent.close() }
        return { dev: identity.dev, ino: identity.ino }
    } finally { await handle.close() }
}

async function removeJournal(pinned: string, journalName: string, journalIdentity: FileIdentity | null, assertUnmoved: () => Promise<void>) {
    await assertUnmoved()
    const path = join(pinned, journalName)
    if (sameFile(journalIdentity, await fileStat(path))) { await assertUnmoved(); await removeName(path); await assertUnmoved() }
}

async function recoverDeleteJournals(directory: string, pinned: string, assertUnmoved: () => Promise<void>, workspaceRoot: (FileIdentity & { path: string }) | null) {
    if (!workspaceRoot) return
    const directoryInfo = await fileStat(directory)
    if (!directoryInfo?.isDirectory()) return
    assertUnmoved = deleteDirectoryGuard(directory, directoryInfo, workspaceRoot, assertUnmoved)
    await assertUnmoved()
    await recoverDeleteStages(directory, directoryInfo, pinned, workspaceRoot, assertUnmoved)
    let names: string[]
    try { names = await readdir(pinned) } catch (error) { if (missing(error)) return; throw error }
    for (const name of names) {
        if (!name.startsWith(DELETE_PREFIX) || !name.endsWith('.json') || claimed(directory, name)) continue
        const journalIdentity = await fileStat(join(pinned, name))
        const raw = await readRecoveryText(join(pinned, name), 8 * 1024 * 1024)
        await assertUnmoved()
        const journal = raw === null ? null : parseDeleteJournal(raw)
        if (!journal || !sameFile(await fileStat(directory), asIdentity(journal.parentDev, journal.parentIno))) continue
        if (!sameFile(workspaceRoot, asIdentity(journal.workspaceDev, journal.workspaceIno))) continue
        if (claimed(directory, journal.name)) continue
        const identity = asIdentity(journal.dev, journal.ino)
        const parent = asIdentity(journal.parentDev, journal.parentIno)
        try {
            if (journal.nodes) {
                const opened = await fileStat(join(pinned, journal.name))
                if (opened && sameFile(opened, identity) && !opened.isSymbolicLink() && opened.isDirectory()) {
                    let child: FileHandle | null = null
                    try {
                        child = await open(join(pinned, journal.name), DIRECTORY_OPEN)
                        const stat = await child.stat({ bigint: true })
                        if (sameFile(stat, identity)) {
                            const canonical = join(directory, journal.name)
                            const guard = deleteDirectoryGuard(canonical, stat, workspaceRoot, assertUnmoved)
                            await guard()
                            await deleteNodes(canonical, { dev: stat.dev, ino: stat.ino }, await pinnedDirectory(child), journal.nodes, workspaceRoot, guard)
                        }
                    } finally { await child?.close() }
                    await removeEmptyDirectory(directory, parent, pinned, journal.name, identity, workspaceRoot, assertUnmoved)
                }
            } else await stageAndUnlinkFile(directory, parent, pinned, journal.name, identity, workspaceRoot, assertUnmoved)
        } catch (error) {
            if (error instanceof DesktopHttpError && (error.status === 503 || error.status === 500)) return
            throw error
        }
        await assertUnmoved()
        const selected = await fileStat(join(pinned, journal.name))
        if ((!selected || !sameFile(selected, identity)) && !await stagedFileRemains(directory, pinned, workspaceRoot, assertUnmoved)) {
            await removeJournal(pinned, name, journalIdentity, assertUnmoved)
        }
    }
}

/** Delete one selected file or folder. Files and nested files are moved aside with the exclusive
 * rename helper, then that private name is unlinked only if it is still the same regular file.
 * Empty directories use the same journaled staging before rmdir. Nothing calls
 * recursive rm on a workspace path. */
export async function deleteCoworkerFile(runtime: DesktopRuntime, agentId: string, path: string, identity?: string): Promise<{ path: string }> {
    return withCoworkerFiles(runtime, agentId, () => deleteEntry(runtime, agentId, path, identity))
}

async function deleteEntry(runtime: DesktopRuntime, agentId: string, path: string, identity?: string): Promise<{ path: string }> {
    if (identity !== undefined && !/^\d{1,24}:\d{1,24}$/.test(identity)) throw new DesktopHttpError(400, 'Send the file or folder to delete.')
    const workspace = await coworkerWorkspace(runtime, agentId)
    const located = await containedPath(workspace, path)
    if (!located.rel) throw new DesktopHttpError(400, 'The root folder cannot be deleted.')
    const slash = located.rel.lastIndexOf('/')
    const parentRel = slash === -1 ? '' : located.rel.slice(0, slash)
    const sourceName = located.rel.slice(slash + 1)
    if (!simpleName(sourceName) || reservedName(sourceName)) throw new DesktopHttpError(400, 'That name can’t be deleted.')
    const parentPath = await containedPath(workspace, parentRel)
    if (!parentPath.root || !parentPath.target) throw new DesktopHttpError(404, `“${sourceName}” was not found.`)
    const folder = parentPath.target
    const root = parentPath.root
    const outside = () => new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const replaced = () => new DesktopHttpError(409, `“${sourceName}” was renamed or replaced. It was left unchanged.`)
    const workspaceInfo = await fileStat(root)
    if (!workspaceInfo?.isDirectory()) throw outside()
    const workspaceIdentity: DeleteWorkspace = { path: root, dev: workspaceInfo.dev, ino: workspaceInfo.ino }
    await recoverInterruptedCoworkerEdits(folder, root)
    const dir = await openResolved(folder, true)
    try {
        const pinned = await pinnedDirectory(dir)
        const parent = await dir.stat({ bigint: true })
        const assertUnmoved = deleteDirectoryGuard(folder, parent, workspaceIdentity, async () => {})
        await assertUnmoved()
        const source = await fileStat(join(pinned, sourceName))
        if (!source) throw new DesktopHttpError(404, `“${sourceName}” was not found.`)
        if (source.isSymbolicLink() || (!source.isFile() && !source.isDirectory())) throw new DesktopHttpError(400, 'Choose a file or folder, not a symlink.')
        if (identity && `${source.dev}:${source.ino}` !== identity) throw replaced()
        if (claimed(folder, sourceName)) throw new DesktopHttpError(409, 'This file is being saved. Try the delete again once that finishes.')
        let nodes: DeleteNode[] | undefined
        if (source.isDirectory()) {
            const child = await open(join(pinned, sourceName), DIRECTORY_OPEN).catch(error => {
                const code = (error as NodeJS.ErrnoException).code
                if (code === 'ELOOP' || code === 'ENOTDIR') throw new DesktopHttpError(400, 'Choose a file or folder, not a symlink.')
                throw error
            })
            try {
                const opened = await child.stat({ bigint: true })
                if (!sameFile(opened, source)) throw replaced()
                const canonical = join(folder, sourceName)
                const guard = deleteDirectoryGuard(canonical, opened, workspaceIdentity, assertUnmoved)
                await guard()
                nodes = await inspectTree(await pinnedDirectory(child), canonical, 1, { n: 0 }, workspaceIdentity, guard)
            } finally { await child.close() }
        }
        assertDeleteHelper()
        const journalName = `${DELETE_PREFIX}${randomBytes(12).toString('hex')}.json`
        const journal: DeleteJournal = {
            v: 1, name: sourceName, dev: idText(source.dev), ino: idText(source.ino),
            parentDev: idText(parent.dev), parentIno: idText(parent.ino),
            workspaceDev: idText(workspaceInfo.dev), workspaceIno: idText(workspaceInfo.ino),
            ...(nodes && { nodes }),
        }
        claim(folder, sourceName)
        claim(folder, journalName)
        let journalIdentity: FileIdentity | null = null
        try {
            await assertUnmoved()
            journalIdentity = await writeDeleteJournal(pinned, journalName, journal, assertUnmoved)
            if (nodes) {
                const child = await open(join(pinned, sourceName), DIRECTORY_OPEN).catch(error => {
                    const code = (error as NodeJS.ErrnoException).code
                    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENOENT') throw replaced()
                    throw error
                })
                try {
                    const opened = await child.stat({ bigint: true })
                    if (!sameFile(opened, source)) throw replaced()
                    const canonical = join(folder, sourceName)
                    const guard = deleteDirectoryGuard(canonical, opened, workspaceIdentity, assertUnmoved)
                    await guard()
                    await deleteNodes(canonical, { dev: opened.dev, ino: opened.ino }, await pinnedDirectory(child), nodes, workspaceIdentity, guard)
                } finally { await child.close() }
                await removeEmptyDirectory(folder, parent, pinned, sourceName, source, workspaceIdentity, assertUnmoved)
            } else await stageAndUnlinkFile(folder, parent, pinned, sourceName, source, workspaceIdentity, assertUnmoved)
            await assertUnmoved()
            const after = await fileStat(join(pinned, sourceName))
            const stuck = await stagedFileRemains(folder, pinned, workspaceIdentity, assertUnmoved)
            if (after && !sameFile(after, source)) {
                if (!stuck) await removeJournal(pinned, journalName, journalIdentity, assertUnmoved)
                throw new DesktopHttpError(409, `“${sourceName}” was replaced during delete. The newer entry was left in place.`)
            }
            if (after && sameFile(after, source)) {
                if (!stuck) await removeJournal(pinned, journalName, journalIdentity, assertUnmoved)
                throw new DesktopHttpError(409, nodes
                    ? 'This folder changed during delete. Matching entries were removed. Newer files were left in place.'
                    : `“${sourceName}” changed during delete. It was left unchanged.`)
            }
            if (stuck) throw new DesktopHttpError(409, 'Delete recovery is incomplete. The staged entries and their journals were kept; refresh Files before trying again.')
            await removeJournal(pinned, journalName, journalIdentity, assertUnmoved)
            return { path: located.rel }
        } catch (error) {
            if (error instanceof DesktopHttpError && error.status === 503 && journalIdentity && !await stagedFileRemains(folder, pinned, workspaceIdentity, assertUnmoved)) {
                await removeJournal(pinned, journalName, journalIdentity, assertUnmoved)
            }
            throw error
        } finally {
            unclaim(folder, sourceName)
            unclaim(folder, journalName)
        }
    } finally { await dir.close() }
}
