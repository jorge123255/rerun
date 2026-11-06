import { canonicalDesktopEngineRoot } from './runtime'
import 'server-only'
import { constants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DesktopHttpError } from './auth'
import { DESKTOP_PDF_MAX_BYTES, DesktopPdfBytesError, desktopPdfKind, inspectDesktopPdfBytes, type DesktopPdfContentType } from './pdf-bytes'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { findDesktopAgent } from './store'
import { withRosterWrite } from './roster-writes'
import { assertCoworkerNotDeleting } from './coworker-delete'

export type CoworkerPdfPreview = { path: string; name: string; bytes: Uint8Array; contentType: DesktopPdfContentType; identity: string }

/** The private folder helpers in coworker-files.ts. Root binds the real closures.
 * There is no second claim set and no copied journal recovery. */
export type CoworkerPdfFolderBoundary = {
    recoverInterruptedEdits(directory: string, workspaceRoot: string): Promise<unknown>
    claimed(directory: string, name: string): boolean
}

const PDF_FOLDER_BOUNDARY = Symbol.for('rerun.desktop.pdfFolderBoundary')
type BoundaryHost = typeof globalThis & { [PDF_FOLDER_BOUNDARY]?: CoworkerPdfFolderBoundary }

function boundaryHost(): BoundaryHost {
    return globalThis as BoundaryHost
}

/** Install the shared recovery and claim closures. Returns a restore for the previous binding.
 * Passing the real `recoverInterruptedCoworkerEdits` and `claimed` is root's fragment.
 * An unbound reader throws before it opens a file. It does not skip recovery. */
export function bindCoworkerPdfFolder(boundary: CoworkerPdfFolderBoundary): () => void {
    const host = boundaryHost()
    const previous = host[PDF_FOLDER_BOUNDARY]
    host[PDF_FOLDER_BOUNDARY] = boundary
    let restored = false
    return () => {
        if (restored) return
        restored = true
        if (previous) host[PDF_FOLDER_BOUNDARY] = previous
        else delete host[PDF_FOLDER_BOUNDARY]
    }
}

function requireCoworkerPdfFolder(): CoworkerPdfFolderBoundary {
    const boundary = boundaryHost()[PDF_FOLDER_BOUNDARY]
    if (!boundary) throw new DesktopHttpError(503, 'PDF preview cannot read a file until folder recovery is connected.')
    return boundary
}

const PDF_IDENTITY = /^\d{1,24}:\d{1,24}$/
const MAX_PDF_DEPTH = 64
const SAFE_ENGINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// Darwin's O_NOFOLLOW_ANY already covers every component and must not be combined with O_NOFOLLOW.
const PDF_FILE_OPEN = constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW)
const EDIT_PREFIX = '.rerun-edit-'
const BACKUP_PREFIX = '.rerun-backup-'
const PUBLISH_PREFIX = '.rerun-publish-'
const RENAME_PREFIX = '.rerun-rename-'
const DELETE_PREFIX = '.rerun-delete-'
const reservedName = (name: string) => name.startsWith(EDIT_PREFIX) || name.startsWith(BACKUP_PREFIX) || name.startsWith(PUBLISH_PREFIX) || name.startsWith(RENAME_PREFIX) || name.startsWith(DELETE_PREFIX) || name.startsWith('.rerun-import-') || name.startsWith('.rerun-retire-')

const inside = (root: string, target: string) => {
    const rel = relative(root, target)
    return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')
const simpleName = (name: string) => name.length > 0 && !name.includes('/') && !name.includes('\\') && !name.includes('\0') && name !== '.' && name !== '..'

type FileIdentity = { dev: bigint; ino: bigint }
const sameFile = (left: FileIdentity | null, right: FileIdentity | null) => !!left && !!right && left.dev === right.dev && left.ino === right.ino

/** Read one existing PDF for the Files preview. Text, image, audio, video, import, and attachment
 * stay on their own paths. The response is the file's own bytes, never a filesystem URL.
 * Folder recovery and the in-process claim check come from the bound coworker-files closures. */
function assertPdfNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DesktopHttpError(499, 'PDF preview was closed.')
}

export async function readCoworkerPdf(runtime: DesktopRuntime, agentId: string, path: string, identity?: string, signal?: AbortSignal): Promise<CoworkerPdfPreview> {
    assertPdfNotAborted(signal)
    const boundary = requireCoworkerPdfFolder()
    return withRosterWrite(async () => {
        assertPdfNotAborted(signal)
        await assertCoworkerNotDeleting(await openDesktopDatabase(runtime.dataRoot), agentId)
        return readPdf(runtime, agentId, path, identity, boundary, signal)
    })
}

async function readPdf(runtime: DesktopRuntime, agentId: string, path: string, identity: string | undefined, boundary: CoworkerPdfFolderBoundary, signal?: AbortSignal): Promise<CoworkerPdfPreview> {
    assertPdfNotAborted(signal)
    if (identity !== undefined && !PDF_IDENTITY.test(identity)) throw new DesktopHttpError(400, 'Send the PDF to preview.')
    const rel = lexicalRelative(path)
    if (!rel) throw new DesktopHttpError(400, 'Choose a PDF file to preview.')
    const parts = rel.split('/')
    if (parts.length > MAX_PDF_DEPTH) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const name = parts[parts.length - 1]!
    if (parts.some(part => !simpleName(part) || reservedName(part))) throw new DesktopHttpError(400, 'That name can’t be previewed.')
    const kind = desktopPdfKind(name)
    if (!kind) throw new DesktopHttpError(415, 'Only PDF files can be previewed.')
    const workspace = await coworkerWorkspace(runtime, agentId)
    const root = await containedPath(workspace, '')
    if (!root.root) throw new DesktopHttpError(404, `“${name}” was not found.`)
    const uid = currentUid()
    const parentRel = parts.slice(0, -1).join('/')
    const parentPath = join(/* turbopackIgnore: true */ root.root, parentRel)
    await assertPdfDirectories(root.root, parts.slice(0, -1), uid, name)
    assertPdfNotAborted(signal)
    await boundary.recoverInterruptedEdits(parentPath, root.root)
    assertPdfNotAborted(signal)
    const parents = await assertPdfDirectories(root.root, parts.slice(0, -1), uid, name)
    const located = join(/* turbopackIgnore: true */ parentPath, name)
    const listed = await fileStat(located)
    if (!listed) throw new DesktopHttpError(404, `“${name}” was not found.`)
    if (listed.isSymbolicLink()) throw new DesktopHttpError(400, 'Choose a PDF file, not a symlink.')
    if (!listed.isFile()) throw new DesktopHttpError(400, 'That path is not a file.')
    if (listed.uid !== uid) throw new DesktopHttpError(403, 'This file belongs to another user. It was left unopened.')
    if (listed.nlink !== BigInt(1)) throw new DesktopHttpError(400, 'This PDF has another link. It was left unopened.')
    if (identity && `${listed.dev}:${listed.ino}` !== identity) throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
    if (listed.size === BigInt(0)) throw new DesktopHttpError(415, 'This PDF is damaged and can’t be previewed.')
    if (listed.size > BigInt(DESKTOP_PDF_MAX_BYTES)) throw new DesktopHttpError(413, 'PDF files can be up to 16 MB.')
    if (boundary.claimed(parentPath, name)) throw new DesktopHttpError(409, 'This file is being saved. Try the preview again once that finishes.')
    // This is a runtime coworker path. Tracing a dynamic realpath at build time
    // otherwise sweeps the source tree into Next's standalone application.
    const canonical = await realpath(/* turbopackIgnore: true */ located).catch(() => null)
    if (canonical !== located || !inside(root.root, canonical)) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    assertPdfNotAborted(signal)
    const dir = await openResolved(parentPath, true)
    try {
        const pinned = await pinnedDirectory(dir)
        const openedParent = await dir.stat({ bigint: true })
        if (!sameFile(openedParent, parents[parents.length - 1] ?? null) || openedParent.uid !== uid) {
            throw new DesktopHttpError(400, 'That folder changed. The PDF was left unopened.')
        }
        const handle = await open(join(pinned, name), PDF_FILE_OPEN).catch(error => {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ELOOP' || code === 'ENOTDIR') throw new DesktopHttpError(400, 'Choose a PDF file, not a symlink.')
            if (code === 'ENOENT') throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
            throw error
        })
        try {
            const opened = await handle.stat({ bigint: true })
            if (!sameFile(opened, listed) || opened.isSymbolicLink() || !opened.isFile() || opened.uid !== uid || opened.nlink !== BigInt(1)) {
                throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
            }
            const length = Number(opened.size)
            if (!Number.isSafeInteger(length) || length > DESKTOP_PDF_MAX_BYTES) throw new DesktopHttpError(413, 'PDF files can be up to 16 MB.')
            if (length < 1) throw new DesktopHttpError(409, `“${name}” was renamed or replaced. It was left unchanged.`)
            assertPdfNotAborted(signal)
            const buffer = Buffer.alloc(length)
            let got = 0
            while (got < length) {
                assertPdfNotAborted(signal)
                const read = await handle.read(buffer, got, length - got, got)
                assertPdfNotAborted(signal)
                if (!read.bytesRead) break
                got += read.bytesRead
            }
            const after = await handle.stat({ bigint: true })
            const still = await fileStat(join(pinned, name))
            if (got !== length || !sameFile(after, listed) || !sameFile(still, listed)
                || after.size !== opened.size || still?.size !== opened.size
                || after.ctimeNs !== opened.ctimeNs || still?.ctimeNs !== opened.ctimeNs
                || after.mtimeNs !== opened.mtimeNs || still?.mtimeNs !== opened.mtimeNs
                || after.uid !== uid || still?.uid !== uid || after.nlink !== BigInt(1) || still?.nlink !== BigInt(1)) {
                throw new DesktopHttpError(409, 'This PDF changed while it was being read.')
            }
            for (const parent of parents) {
                const now = await fileStat(parent.path)
                if (!now || now.isSymbolicLink() || !now.isDirectory() || !sameFile(now, parent) || now.uid !== uid) {
                    throw new DesktopHttpError(400, 'That folder changed. The PDF was left unopened.')
                }
            }
            assertPdfNotAborted(signal)
            let inspected: ReturnType<typeof inspectDesktopPdfBytes>
            try { inspected = inspectDesktopPdfBytes(kind, buffer.subarray(0, got)) }
            catch (error) {
                if (error instanceof DesktopPdfBytesError && error.reason === 'mismatch') throw new DesktopHttpError(415, 'This file is not a supported PDF.')
                if (error instanceof DesktopPdfBytesError && error.reason === 'unsupported') throw new DesktopHttpError(415, 'This PDF format can’t be previewed.')
                throw new DesktopHttpError(415, 'This PDF is damaged and can’t be previewed.')
            }
            return { path: rel, name, bytes: new Uint8Array(buffer.subarray(0, got)), contentType: inspected.contentType, identity: `${listed.dev}:${listed.ino}` }
        } finally { await handle.close() }
    } finally { await dir.close() }
}

async function coworkerWorkspace(runtime: DesktopRuntime, agentId: string): Promise<string> {
    const coworker = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
    if (!coworker) throw new DesktopHttpError(404, 'Coworker not found')
    if (!SAFE_ENGINE_ID.test(coworker.engineAgentId)) throw new DesktopHttpError(400, 'This coworker has no readable workspace.')
    return resolve(await canonicalDesktopEngineRoot(runtime), 'agents', coworker.engineAgentId, 'workspace')
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
    if (typeof process.getuid !== 'function') throw new DesktopHttpError(400, 'PDF preview is only available on this Mac.')
    return BigInt(process.getuid())
}

async function assertPdfDirectories(root: string, directories: string[], uid: bigint, fileName: string): Promise<Array<FileIdentity & { path: string }>> {
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
        if (info.isSymbolicLink()) throw new DesktopHttpError(400, 'Choose a PDF file, not a symlink.')
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
