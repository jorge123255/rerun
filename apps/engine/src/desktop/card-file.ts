import { CARD_MAX_FILES, CARD_MAX_IMAGE_BYTES, CARD_MAX_IMAGE_TOTAL_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES, isDesktopAttachmentPath, type FileCard, type FileCardEntry } from '@rerun/contracts'
import { tool, type ToolSet } from 'ai'
import { basename, isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'
import { workspaceDir } from '../config/paths.js'
import type { RunContext } from '../runtime/context.js'
import { jsonTolerantArray } from '../tools/builtin/hitl.js'
import { openWithoutLinks } from './open-without-links.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from './tool-grants.js'
import { validPath, workspacePath, workspaceRoot } from './workspace-read.js'

class CardFileError extends Error {}

const unavailable = 'That file is unavailable in this coworker’s workspace.'
const tooLarge = 'Result card text files can only be up to 32 KiB.'
const imageTooLarge = 'Result card images can only be up to 8 MB.'
const imageEmpty = 'That image is empty and can’t be previewed.'
const imageBudget = 'Those images would exceed the 24 MB result-card preview budget. Show fewer images.'
const badPath = 'Use a visible .txt, .md, .png, .jpg, .jpeg, .webp or .gif relative file path inside this coworker’s workspace.'
const shared = 'Shared files are not available in a Mac result card.'

const CARD_IMAGE = /\.(?:png|jpe?g|gif|webp)$/i
const isCardImage = (path: string) => CARD_IMAGE.test(path)
const isCardPath = (path: string) => isDesktopAttachmentPath(path) || isCardImage(path)

function assertScope(scope: 'agent' | 'shared' | undefined) {
    // A card is only a reference to a file this coworker owns. The shared space has no desktop
    // path through the authenticated files/read route yet, so it is refused rather than guessed.
    if (scope && scope !== 'agent') throw new CardFileError(shared)
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

async function entryFor(ctx: RunContext, path: string, scope: 'agent' | 'shared' | undefined): Promise<FileCardEntry> {
    await requireDesktopToolGrant(ctx, 'cardFile')
    assertScope(scope)
    try {
        const rel = await cardRelativePath(ctx, path)
        const target = await workspacePath(ctx.agent.id, rel)
        const handle = await openWithoutLinks(target)
        try {
            const info = await handle.stat({ bigint: true })
            if (info.isDirectory()) throw new CardFileError('That path is a folder, not a file.')
            if (!info.isFile() || info.nlink !== 1n) throw new CardFileError(unavailable)
            const image = isCardImage(rel)
            if (image && info.size === 0n) throw new CardFileError(imageEmpty)
            if (info.size > BigInt(image ? CARD_MAX_IMAGE_BYTES : DESKTOP_ATTACHMENT_MAX_BYTES)) throw new CardFileError(image ? imageTooLarge : tooLarge)
            // Pin the same inode twice: a path moved into another workspace, or replaced while this
            // card is being made, must not appear as this coworker's file.
            const current = await openWithoutLinks(target)
            try {
                const check = await current.stat({ bigint: true })
                if (!check.isFile() || check.dev !== info.dev || check.ino !== info.ino || check.nlink !== 1n
                    || check.size !== info.size || check.ctimeNs !== info.ctimeNs) throw new CardFileError(unavailable)
            } finally { await current.close() }
            await requireDesktopToolGrant(ctx, 'cardFile')
            return { path: rel, name: basename(rel), size: Number(info.size), scope: 'agent', ...(image ? { identity: `${info.dev}:${info.ino}` } : {}) }
        } finally { await handle.close() }
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
                'Show existing .txt, .md, or static .png/.jpg/.jpeg/.webp/.gif files already saved in this coworker’s persistent Files workspace as preview tiles in chat. Pass visible paths relative to Files; up to 12 files, 32 KiB per text file, 8 MB per image, and 24 MB of images per card. Animated GIF/APNG/WebP, SVG, PDF, video and other formats are unavailable. This does not save, import or publish a file. Native Codex commands and edits use a separate temporary folder whose changes are discarded: never use this tool to deliver those changes, because a matching relative path here would show the persistent original instead. Use it before asking the user to review or choose among existing Files documents or images. Opening a tile reads the current persistent file, not frozen bytes; the image endpoint rechecks the bytes and dimensions when it opens. The tool does not read content back to you. Shared files, folders and links are unavailable.',
            inputSchema: z.object({
                files: jsonTolerantArray(
                    z.array(z.object({
                        path: z.string().describe('Visible path relative to this coworker’s persistent Files workspace, not the native command/edit folder'),
                        scope: z.enum(['agent', 'shared']).optional().describe("Only 'agent' is available in the Mac app"),
                    })).min(1).max(CARD_MAX_FILES)
                ).describe('The files to show together, in the order the user should see them'),
            }),
            execute: async ({ files }) => {
                await requireDesktopToolGrant(ctx, 'cardFile')
                const shown: FileCardEntry[] = []
                const failures: string[] = []
                for (const file of files) {
                    try { shown.push(await entryFor(ctx, file.path, file.scope)) }
                    catch (error) {
                        ctx.abortSignal?.throwIfAborted()
                        failures.push(`${file.path}: ${error instanceof Error ? error.message : unavailable}`)
                    }
                }
                // A partial card would hide from the model that one of the files was missing.
                if (failures.length) return `Could not show ${failures.length === 1 ? 'that file' : 'those files'}, nothing was shown:\n${failures.join('\n')}`
                const imageBytes = shown.reduce((sum, file) => sum + (isCardImage(file.path) ? file.size : 0), 0)
                if (imageBytes > CARD_MAX_IMAGE_TOTAL_BYTES) return `Could not show those files, nothing was shown:\n${imageBudget}`
                await requireDesktopToolGrant(ctx, 'cardFile')
                const card: FileCard = { kind: 'file', files: shown }
                return JSON.stringify(card)
            },
        }),
    }
}
