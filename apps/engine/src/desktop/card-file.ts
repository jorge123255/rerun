import { CARD_MAX_AUDIO_BYTES, CARD_MAX_FILES, CARD_MAX_IMAGE_BYTES, CARD_MAX_IMAGE_TOTAL_BYTES, CARD_MAX_VIDEO_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES, isDesktopAttachmentPath, type FileCard, type FileCardEntry } from '@rerun/contracts'
import { tool, type ToolSet } from 'ai'
import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'
import { dataDir, workspaceDir } from '../config/paths.js'
import type { RunContext } from '../runtime/context.js'
import { jsonTolerantArray } from '../tools/builtin/hitl.js'
import { openWithoutLinks } from './open-without-links.js'
import { listSharedDirectory, resolveEngineSharedDirectory, SharedWorkspaceFileError } from './shared-workspace-files.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from './tool-grants.js'
import { validPath, workspacePath, workspaceRoot } from './workspace-read.js'

class CardFileError extends Error {}

const unavailable = 'That file is unavailable in this coworker’s workspace.'
const tooLarge = 'Result card text files can only be up to 32 KiB.'
const imageTooLarge = 'Result card images can only be up to 8 MB.'
const imageEmpty = 'That image is empty and can’t be previewed.'
const audioTooLarge = 'Result card audio files can only be up to 16 MB.'
const audioEmpty = 'That audio file is empty and can’t be previewed.'
const videoTooLarge = 'Result card videos can only be up to 16 MB.'
const videoEmpty = 'That video is empty and can’t be previewed.'
const pdfTooLarge = 'Result card PDFs can only be up to 16 MB.'
const pdfEmpty = 'That PDF is empty and can’t be previewed.'
const imageBudget = 'Those images and videos would exceed the 24 MB result-card preview budget. Show fewer media files.'
const badPath = 'Use a visible .txt, .md, .pdf, .png, .jpg, .jpeg, .webp, .gif, .svg, .avif, .ico, .bmp, .wav, .mp3, .m4a, .ogg, .flac, .mp4, .webm, .mov or .m4v relative file path inside this coworker’s workspace.'
const shared = 'Shared files are not available in a Mac result card.'
const binaryEmpty = 'That file is empty and can’t be downloaded.'
const binaryTooLarge = 'Result card files can only be up to 16 MB.'

/** Matches DESKTOP_PDF_MAX_BYTES. The shared card contract is unchanged, so the cap stays local. */
export const DESKTOP_CARD_PDF_MAX_BYTES = 16 * 1024 * 1024
/** Download tiles for files the preview routes do not render. Same local cap as a PDF. */
export const DESKTOP_CARD_BINARY_MAX_BYTES = 16 * 1024 * 1024

// Scope is the field the model set. A path, including an absolute shared-folder path, never changes it.
export function explicitDesktopCardScope(scope: 'agent' | 'shared' | undefined): 'agent' | 'shared' {
    return scope === 'shared' ? 'shared' : 'agent'
}

export function desktopCardFilePublication<T>(entries: ReadonlyArray<{ ok: true; file: T } | { ok: false; message: string }>): { ok: true; files: T[] } | { ok: false; message: string } {
    const failures = entries.flatMap(entry => entry.ok ? [] : [entry.message])
    if (failures.length) return { ok: false, message: `Could not show ${failures.length === 1 ? 'that file' : 'those files'}, nothing was shown:\n${failures.join('\n')}` }
    return { ok: true, files: entries.flatMap(entry => entry.ok ? [entry.file] : []) }
}

const CARD_IMAGE = /\.(?:png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i
const CARD_AUDIO = /\.(?:wav|mp3|m4a|ogg|flac)$/i
const CARD_VIDEO = /\.(?:mp4|webm|mov|m4v)$/i
const CARD_PDF = /\.pdf$/i
const isCardImage = (path: string) => CARD_IMAGE.test(path)
const isCardAudio = (path: string) => CARD_AUDIO.test(path)
const isCardVideo = (path: string) => CARD_VIDEO.test(path)
const isCardPdf = (path: string) => CARD_PDF.test(path)
const SHARED_PART = /^[^/\\.\0][^/\\\0]{0,240}$/
const isGenericFile = (path: string) => validPath(path) && !isCardImage(path) && !isCardAudio(path) && !isCardVideo(path) && !isCardPdf(path) && !isDesktopAttachmentPath(path) && SHARED_PART.test(path.split('/').at(-1) ?? '')
const isCardPath = (path: string) => isDesktopAttachmentPath(path) || isCardImage(path) || isCardAudio(path) || isCardVideo(path) || isCardPdf(path) || isGenericFile(path)

type CardKind = 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'binary'

function kindOf(path: string): CardKind {
    if (isCardImage(path)) return 'image'
    if (isCardAudio(path)) return 'audio'
    if (isCardVideo(path)) return 'video'
    if (isCardPdf(path)) return 'pdf'
    if (isDesktopAttachmentPath(path)) return 'text'
    return 'binary'
}

// Accept an absolute persistent workspace path only when it stays inside this coworker's Files
// workspace. Native Codex command/edit paths belong to a separate temporary folder, not this one.
const inside = (rel: string) => !!rel && !rel.startsWith('..') && !isAbsolute(rel)

async function cardRelativePath(ctx: RunContext, path: string): Promise<string> {
    if (!path || path.length > 4096 || /[\\\p{Cc}]/u.test(path) || path.split('/').some(part => part === '..')) throw new CardFileError(badPath)
    const workspace = await workspaceRoot(ctx.agent.id)
    // The model may copy the workspace path as the app prints it (/var/…) or as the filesystem
    // canonicalises it (/private/var/…). Match either prefix, then open only the relative path so
    // openWithoutLinks still refuses a symlink anywhere inside the workspace.
    const rel = isAbsolute(path)
        ? [relative(workspaceDir(ctx.agent.id), path), relative(workspace, path)].find(inside)
        : relative(workspace, join(workspace, path))
    if (!rel || !inside(rel) || !isCardPath(rel) || !validPath(rel)) throw new CardFileError(badPath)
    return rel
}

function bounds(kind: CardKind, size: bigint) {
    if (kind === 'image' && size === 0n) throw new CardFileError(imageEmpty)
    if (kind === 'audio' && size === 0n) throw new CardFileError(audioEmpty)
    if (kind === 'video' && size === 0n) throw new CardFileError(videoEmpty)
    if (kind === 'pdf' && size === 0n) throw new CardFileError(pdfEmpty)
    if (kind === 'binary' && size === 0n) throw new CardFileError(binaryEmpty)
    const max = kind === 'image' ? CARD_MAX_IMAGE_BYTES : kind === 'video' ? CARD_MAX_VIDEO_BYTES : kind === 'audio' ? CARD_MAX_AUDIO_BYTES : kind === 'pdf' ? DESKTOP_CARD_PDF_MAX_BYTES : kind === 'binary' ? DESKTOP_CARD_BINARY_MAX_BYTES : DESKTOP_ATTACHMENT_MAX_BYTES
    if (size > BigInt(max)) throw new CardFileError(kind === 'image' ? imageTooLarge : kind === 'video' ? videoTooLarge : kind === 'audio' ? audioTooLarge : kind === 'pdf' ? pdfTooLarge : kind === 'binary' ? binaryTooLarge : tooLarge)
}

async function requireShared(ctx: RunContext) {
    try {
        await requireDesktopToolGrant(ctx, 'cardFile')
        await requireDesktopToolGrant(ctx, 'sharedFilesRead')
    } catch (error) {
        ctx.abortSignal?.throwIfAborted()
        throw new CardFileError(shared)
    }
}

function sharedRelative(path: string): string {
    if (!path || path.length > 4096 || isAbsolute(path) || /[\\\p{Cc}]/u.test(path) || path.split('/').some(part => part === '..')) throw new CardFileError(badPath)
    const parts = path.split('/')
    if (!parts.length || parts.length > 32 || parts.some(part => !SHARED_PART.test(part))) throw new CardFileError(badPath)
    return parts.join('/')
}

async function pinFile(target: string, kind: CardKind) {
    const handle = await openWithoutLinks(target)
    try {
        const info = await handle.stat({ bigint: true })
        if (info.isDirectory()) throw new CardFileError('That path is a folder, not a file.')
        if (!info.isFile() || info.nlink !== 1n) throw new CardFileError(unavailable)
        bounds(kind, info.size)
        const current = await openWithoutLinks(target)
        try {
            const check = await current.stat({ bigint: true })
            if (!check.isFile() || check.dev !== info.dev || check.ino !== info.ino || check.nlink !== 1n
                || check.size !== info.size || check.ctimeNs !== info.ctimeNs) throw new CardFileError(unavailable)
        } finally { await current.close() }
        return info
    } finally { await handle.close() }
}

async function sharedEntry(ctx: RunContext, path: string): Promise<FileCardEntry> {
    await requireShared(ctx)
    const rel = sharedRelative(path)
    const kind = kindOf(rel)
    const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
    try {
        const root = await resolveEngineSharedDirectory(await realpath(dataDir()), signal)
        const parts = rel.split('/')
        const name = parts.at(-1)!
        const parent = parts.length === 1 ? '.' : parts.slice(0, -1).join('/')
        const listing = await listSharedDirectory(root, parent, { signal, beforeCommit: () => requireShared(ctx) })
        const listed = listing.entries.find(entry => entry.type === 'file' && entry.name === name)
        if (!listed) throw new CardFileError(unavailable)
        const target = join(root, rel)
        const back = relative(root, target)
        if (back !== rel || isAbsolute(back)) throw new CardFileError(badPath)
        const info = await pinFile(target, kind)
        if (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) throw new CardFileError(unavailable)
        if (Number(info.size) !== listed.size) throw new CardFileError(unavailable)
        await requireShared(ctx)
        // Shared text keeps an identity so a replaced file is refused at open. Private text does not.
        return { path: rel, name, size: Number(info.size), scope: 'shared', identity: `${info.dev}:${info.ino}` }
    } catch (error) {
        ctx.abortSignal?.throwIfAborted()
        if (error instanceof CardFileError) throw error
        if (error instanceof SharedWorkspaceFileError) throw new CardFileError(error.status === 403 ? shared : unavailable)
        throw new CardFileError(unavailable)
    }
}

async function entryFor(ctx: RunContext, path: string, requested: 'agent' | 'shared' | undefined): Promise<FileCardEntry> {
    // The requested scope is the only selector. An absolute path is not reread as the other scope.
    if (explicitDesktopCardScope(requested) === 'shared') return sharedEntry(ctx, path)
    await requireDesktopToolGrant(ctx, 'cardFile')
    try {
        const rel = await cardRelativePath(ctx, path)
        const kind = kindOf(rel)
        const target = await workspacePath(ctx.agent.id, rel)
        const info = await pinFile(target, kind)
        await requireDesktopToolGrant(ctx, 'cardFile')
        const identity = `${info.dev}:${info.ino}`
        return { path: rel, name: basename(rel), size: Number(info.size), scope: 'agent', ...(kind === 'text' ? {} : { identity }) }
    } catch (error) {
        ctx.abortSignal?.throwIfAborted()
        await requireDesktopToolGrant(ctx, 'cardFile')
        if (error instanceof CardFileError) throw error
        throw new CardFileError(unavailable)
    }
}

export function desktopCardFileTools(ctx: RunContext): ToolSet {
    if (!hasDesktopToolGrant(ctx.agent.config, 'cardFile')) return {}
    return {
        card_file: tool({
            description:
                'Show existing files already saved for this coworker as preview or download tiles in chat. Preview types are .txt, .md, .pdf, .png/.jpg/.jpeg/.webp/.gif/.svg/.avif/.ico/.bmp, .wav/.mp3/.m4a/.ogg/.flac, and .mp4/.webm/.mov/.m4v. Other visible files in this workspace are download tiles: they are not previewed, executed, unpacked or converted. Pass visible relative paths; up to 12 files, 32 KiB per text file, 16 MB per PDF, download file, audio file or video, 8 MB per image, and 24 MB of workspace images and videos combined per card. PDFs are document tiles, not image or video album entries. GIF/WebP animations use the bounded Files preview; SVG is limited to the accepted static subset rendered as PNG, and AVIF/ICO/BMP are converted to PNG. APNG and unsupported or unsafe content are refused. Audio is fetched only when opened and plays only after the user presses play. A PDF page is fetched only when that PDF is opened. Video previews show the first frame and play only after the user acts; only visible album previews are loaded. This does not save, import, publish or search a file, and it does not read PDF content back to you. Native Codex commands and edits use a separate temporary folder: pending changes must go through the native file review before they become persistent Files. Never use this tool to deliver unaccepted changes, because a matching relative path here would show the persistent original instead. Use it before asking the user to review or choose among existing Files documents, PDFs, images, audio or video. Opening a tile reads the current persistent file, not frozen bytes; the media and PDF page endpoints recheck the bytes and identity when they open. The tool does not read content back to you. A file in the workspace shared folder is included only when scope is "shared" and shared files permission is on; the path does not choose the scope. Omit scope for a private workspace file. Folders and links are unavailable.',
            inputSchema: z.object({
                files: jsonTolerantArray(
                    z.array(z.object({
                        path: z.string().describe('Visible relative path. Private files are relative to this coworker’s persistent Files workspace. Shared files are relative to the workspace shared folder. Not the native command/edit folder.'),
                        scope: z.enum(['agent', 'shared']).optional().describe("Omit or 'agent' for this coworker’s Files. 'shared' only when shared files permission is on. A path never selects the scope."),
                    })).min(1).max(CARD_MAX_FILES)
                ).describe('The files to show together, in the order the user should see them'),
            }),
            execute: async ({ files }) => {
                await requireDesktopToolGrant(ctx, 'cardFile')
                const results: Array<{ ok: true; file: FileCardEntry } | { ok: false; message: string }> = []
                for (const file of files) {
                    try { results.push({ ok: true, file: await entryFor(ctx, file.path, file.scope) }) }
                    catch (error) {
                        ctx.abortSignal?.throwIfAborted()
                        results.push({ ok: false, message: `${file.path}: ${error instanceof Error ? error.message : unavailable}` })
                    }
                }
                const published = desktopCardFilePublication(results)
                if (!published.ok) return published.message
                const shown = published.files
                // Shared files and download tiles stay outside the private image/video album budget.
                const mediaBytes = shown.reduce((sum, file) => sum + (file.scope !== 'shared' && (isCardImage(file.path) || isCardVideo(file.path)) ? file.size : 0), 0)
                if (mediaBytes > CARD_MAX_IMAGE_TOTAL_BYTES) return `Could not show those files, nothing was shown:\n${imageBudget}`
                await requireDesktopToolGrant(ctx, 'cardFile')
                if (shown.some(file => file.scope === 'shared')) {
                    try { await requireDesktopToolGrant(ctx, 'sharedFilesRead') }
                    catch (error) {
                        ctx.abortSignal?.throwIfAborted()
                        return `Could not show those files, nothing was shown:\n${shared}`
                    }
                }
                const card: FileCard = { kind: 'file', files: shown }
                return JSON.stringify(card)
            },
        }),
    }
}
