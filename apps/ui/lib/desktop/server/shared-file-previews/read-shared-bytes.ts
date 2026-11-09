import 'server-only'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { openWithoutLinks } from '../../../../../engine/src/desktop/open-without-links'
import { resolveEngineSharedDirectory, SharedWorkspaceFileError, type SharedFileAccess } from '../../../../../engine/src/desktop/shared-workspace-files'
import { desktopAudioKind, inspectDesktopAudioBytes } from '../audio-bytes'
import { desktopRasterKind, inspectDesktopImageBytes } from '../image-bytes'
import { desktopPdfKind, inspectDesktopPdfBytes } from '../pdf-bytes'
import { desktopVideoKind, inspectDesktopVideoBytes } from '../video-bytes'
import type { DesktopRuntime } from '../runtime'

export type SharedPreviewKind = 'image' | 'audio' | 'video' | 'pdf' | 'download'
export type SharedPreviewBytes = { path: string; name: string; bytes: Uint8Array; contentType: string; identity: string }

const MAX_BYTES = 16 * 1024 * 1024
const MAX_DEPTH = 32
const reserved = (part: string) => part.normalize('NFKC').toLowerCase().startsWith('.rerun')

function partsOf(path: string): string[] {
    if (path.length > 4096 || /[\0\\]/.test(path) || isAbsolute(path)) throw new SharedWorkspaceFileError(400, 'That path is outside the shared folder.')
    const parts = path.split('/').filter(part => part && part !== '.')
    if (!parts.length || parts.length > MAX_DEPTH || parts.some(part => part === '..' || reserved(part))) {
        throw new SharedWorkspaceFileError(400, 'That path is outside the shared folder.')
    }
    return parts
}

function contained(root: string, target: string): void {
    const rel = relative(root, target)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new SharedWorkspaceFileError(400, 'That path is outside the shared folder.')
}

function uid(): bigint {
    if (typeof process.getuid !== 'function') throw new SharedWorkspaceFileError(400, 'Shared files are only available on this Mac.')
    return BigInt(process.getuid())
}

async function directory(path: string): Promise<FileHandle> {
    const handle = await openWithoutLinks(path, true)
    const info = await handle.stat({ bigint: true })
    if (!info.isDirectory() || info.uid !== uid() || await realpath(path) !== path) {
        await handle.close()
        throw new SharedWorkspaceFileError(400, 'That path is outside the shared folder.')
    }
    return handle
}

export async function readSharedBytes(runtime: DesktopRuntime, path: string, kind: SharedPreviewKind, access?: SharedFileAccess): Promise<SharedPreviewBytes> {
    const parts = partsOf(path)
    const name = parts.at(-1)!
    const root = await resolveEngineSharedDirectory(runtime.dataRoot, access?.signal)
    const rel = parts.join('/')
    await access?.beforeCommit?.()
    const rootHandle = await directory(root)
    const handles: FileHandle[] = [rootHandle]
    try {
        let current = root
        for (const part of parts.slice(0, -1)) {
            current = join(current, part)
            contained(root, current)
            handles.push(await directory(current))
        }
        const target = join(root, rel)
        contained(root, target)
        const listed = await lstat(target, { bigint: true })
        if (listed.isSymbolicLink() || !listed.isFile() || listed.nlink !== BigInt(1) || listed.uid !== uid()) {
            throw new SharedWorkspaceFileError(400, 'This shared file is linked elsewhere. It was left unopened.')
        }
        if (listed.size > BigInt(MAX_BYTES)) throw new SharedWorkspaceFileError(413, 'This shared file is too large to preview or save.')
        const file = await openWithoutLinks(target, false)
        handles.push(file)
        const opened = await file.stat({ bigint: true })
        if (opened.dev !== listed.dev || opened.ino !== listed.ino || opened.nlink !== BigInt(1) || opened.uid !== uid() || !opened.isFile()) {
            throw new SharedWorkspaceFileError(400, 'This shared file is linked elsewhere. It was left unopened.')
        }
        if (opened.size > BigInt(MAX_BYTES)) throw new SharedWorkspaceFileError(413, 'This shared file is too large to preview or save.')
        if (opened.size !== listed.size || opened.ctimeNs !== listed.ctimeNs) {
            throw new SharedWorkspaceFileError(409, 'This file changed while it was being read.')
        }
        const size = Number(opened.size)
        const bytes = Buffer.alloc(size)
        let read = 0
        while (read < size) {
            access?.signal?.throwIfAborted()
            const next = await file.read(bytes, read, size - read, read)
            if (!next.bytesRead) break
            read += next.bytesRead
        }
        if (read !== size) throw new SharedWorkspaceFileError(409, 'This file changed while it was being read.')
        const after = await file.stat({ bigint: true })
        const named = await lstat(target, { bigint: true })
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== BigInt(1) || after.size !== opened.size || after.ctimeNs !== opened.ctimeNs
            || named.dev !== after.dev || named.ino !== after.ino || named.ctimeNs !== after.ctimeNs || named.nlink !== BigInt(1)) {
            throw new SharedWorkspaceFileError(409, 'This file changed while it was being read.')
        }
        const exact = bytes.subarray(0, read)
        const contentType = kind === 'image' ? inspectDesktopImageBytes(desktopRasterKind(name)!, exact).contentType
            : kind === 'audio' ? inspectDesktopAudioBytes(desktopAudioKind(name)!, exact).contentType
            : kind === 'video' ? inspectDesktopVideoBytes(desktopVideoKind(name)!, exact).contentType
            : kind === 'pdf' ? inspectDesktopPdfBytes(desktopPdfKind(name)!, exact).contentType
            : 'application/octet-stream'
        await access?.beforeCommit?.()
        return { path: rel, name, bytes: exact, contentType, identity: createHash('sha256').update(exact).digest('hex') }
    } finally {
        for (const handle of handles.reverse()) await handle.close()
    }
}
