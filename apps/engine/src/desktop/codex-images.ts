import type { LanguageModelMiddleware } from 'ai'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { CARD_MAX_IMAGE_BYTES, desktopCodexGrantsOf, type FileCard } from '@rerun/contracts'
import { readAgentConfig } from '../agents/loader.js'
import { validPath, workspaceRoot } from './workspace-read.js'
import { openWithoutLinks, readBoundedFileWithoutLinks } from './open-without-links.js'
import { requireDesktopToolGrant } from './tool-grants.js'
import { sessionClaim } from '../runtime/run-control.js'
import type { RunContext } from '../runtime/context.js'

// Codex names this tool once the CLI adapter maps an imageGeneration item. A coworker with the
// native image permission gets the tool; this file keeps each result the adapter names, and only
// into this coworker's own Files.
export const IMAGE_GENERATION_TOOL = 'image_generation'
export const GENERATED_IMAGES_DIR = 'generated-images'

const MESSAGES = {
    adapter: 'Image generation is not available on this adapter.',
    run: 'Image generation is not available for this run.',
    coworker: 'Image generation is not available for this coworker.',
    outside: 'Could not keep the generated image: the file is outside this run.',
    empty: 'Could not keep the generated image: that image is empty.',
    large: 'Could not keep the generated image: that image is too large.',
    unsupported: 'Could not keep the generated image: that file is not a supported image.',
    nodata: 'Could not keep the generated image: Codex returned no image data',
    exists: 'Could not keep the generated image: that file is already in this coworker’s Files.',
    keep: 'Could not keep the generated image.',
} as const

class ImageKeepError extends Error {
    constructor(readonly code: keyof typeof MESSAGES) {
        super(MESSAGES[code])
    }
}

export type DesktopCodexImageRun = {
    runId: string
    sessionId: string
    abortSignal?: AbortSignal
    /** Directory owned by this run. A saved image is copied only from inside it. */
    runRoot?: string
}

export type DesktopCodexImageContext = DesktopCodexImageRun & {
    provider: string
    agent: { id: string }
}

type ImageGenerationItem = {
    id: string
    status?: string
    revisedPrompt?: string | null
    failure?: unknown
    savedPath?: string | null
    result?: string | null
}

type ToolPart = {
    type: string
    id?: string
    toolCallId?: string
    toolName?: string
    delta?: string
    input?: string
    result?: unknown
    preliminary?: boolean
    isError?: boolean
}

const MAX_BASE64 = Math.ceil(CARD_MAX_IMAGE_BYTES / 3) * 4
const IDENTITY = /^\d{1,24}:\d{1,24}$/
const RUN_ID = /^[A-Za-z0-9_-]{1,80}$/

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function imageItem(value: unknown): ImageGenerationItem | null {
    let parsed: unknown = value
    if (typeof value === 'string') {
        try { parsed = JSON.parse(value) } catch { return null }
    }
    const item = record(parsed)
    if (!item || typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 200) return null
    return item as ImageGenerationItem
}

const imageInput = (item: ImageGenerationItem | null): string => JSON.stringify({ prompt: item?.revisedPrompt ?? null })

function failureText(failure: unknown): string {
    let text = 'Image generation failed'
    if (typeof failure === 'string' && failure) text = failure
    else {
        const detail = record(failure)
        if (detail && typeof detail.message === 'string' && detail.message) text = detail.message
        else if (detail) {
            const [kind] = Object.keys(detail)
            if (kind) text = kind.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
        }
    }
    if (text.length > 300 || /[A-Za-z0-9+/]{80}/.test(text)) return 'Image generation failed'
    return text
}

function staysInside(root: string, target: string): boolean {
    if (!isAbsolute(root) || !isAbsolute(target)) return false
    const rel = relative(root, target)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function overlaps(left: string, right: string): boolean {
    return left === right || staysInside(left, right) || staysInside(right, left)
}

function safeAbsolute(path: string): boolean {
    return isAbsolute(path) && path.length <= 4096 && !path.includes('\0') && !/[\p{Cc}]/u.test(path)
}

function extensionOf(bytes: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png'
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
    if (bytes.length >= 6) {
        const header = bytes.toString('ascii', 0, 6)
        if (header === 'GIF87a' || header === 'GIF89a') return 'gif'
    }
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
    return null
}

function imageName(id: string, ext: 'png' | 'jpg' | 'gif' | 'webp'): string {
    const stem = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)
    return `${stem || 'generated_image'}.${ext}`
}

function exactRun(ctx: DesktopCodexImageContext): boolean {
    if (!RUN_ID.test(ctx.runId) || !RUN_ID.test(ctx.sessionId) || !ctx.abortSignal) return false
    const claim = sessionClaim(ctx.sessionId)
    return !claim || claim.runId === ctx.runId
}

async function assertGrant(ctx: DesktopCodexImageContext): Promise<void> {
    ctx.abortSignal?.throwIfAborted()
    try {
        // The coworker's own image permission keeps what it made; "Show result files" still works too.
        const config = await readAgentConfig(ctx.agent.id).catch(() => null)
        ctx.abortSignal?.throwIfAborted()
        if (config?.enabled && desktopCodexGrantsOf(config.tools).images) return
        await requireDesktopToolGrant({ agent: { id: ctx.agent.id }, abortSignal: ctx.abortSignal } as RunContext, 'cardFile')
    } catch {
        ctx.abortSignal?.throwIfAborted()
        throw new ImageKeepError('coworker')
    }
}

function inlineBytes(result: string): Buffer {
    if (result.length === 0 || result.length > MAX_BASE64 || result.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result)) {
        throw new ImageKeepError('unsupported')
    }
    const bytes = Buffer.from(result, 'base64')
    if (bytes.length === 0 || bytes.length > CARD_MAX_IMAGE_BYTES || bytes.toString('base64') !== result) throw new ImageKeepError('unsupported')
    return bytes
}

async function readApproved(ctx: DesktopCodexImageContext, savedPath: string): Promise<Buffer> {
    if (!ctx.runRoot || process.platform !== 'darwin' || !safeAbsolute(savedPath)) throw new ImageKeepError('outside')
    const workspace = await workspaceRoot(ctx.agent.id)
    let canonical: string
    try {
        const root = await realpath(ctx.runRoot)
        if (overlaps(root, workspace)) throw new ImageKeepError('outside')
        const listed = await lstat(savedPath)
        if (listed.isSymbolicLink() || !listed.isFile() || listed.nlink !== 1) throw new ImageKeepError('outside')
        if (listed.size === 0) throw new ImageKeepError('empty')
        if (listed.size > CARD_MAX_IMAGE_BYTES) throw new ImageKeepError('large')
        canonical = await realpath(savedPath)
        if (!staysInside(root, canonical) || staysInside(workspace, canonical)) throw new ImageKeepError('outside')
    } catch (error) {
        if (error instanceof ImageKeepError) throw error
        throw new ImageKeepError('outside')
    }
    try { return await readBoundedFileWithoutLinks(canonical, CARD_MAX_IMAGE_BYTES) }
    catch {
        ctx.abortSignal?.throwIfAborted()
        throw new ImageKeepError('keep')
    }
}

async function writeGenerated(ctx: DesktopCodexImageContext, id: string, bytes: Buffer): Promise<FileCard> {
    if (process.platform !== 'darwin') throw new ImageKeepError('keep')
    if (bytes.length === 0) throw new ImageKeepError('empty')
    if (bytes.length > CARD_MAX_IMAGE_BYTES) throw new ImageKeepError('large')
    const ext = extensionOf(bytes)
    if (!ext) throw new ImageKeepError('unsupported')
    const name = imageName(id, ext)
    const rel = `${GENERATED_IMAGES_DIR}/${name}`
    if (!validPath(rel) || name !== rel.split('/').at(-1)) throw new ImageKeepError('keep')
    const workspace = await workspaceRoot(ctx.agent.id)
    const dir = join(workspace, GENERATED_IMAGES_DIR)
    const target = join(workspace, rel)
    if (relative(workspace, target) !== rel) throw new ImageKeepError('keep')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const dirInfo = await lstat(dir)
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new ImageKeepError('keep')
    if (!staysInside(workspace, await realpath(dir))) throw new ImageKeepError('keep')
    ctx.abortSignal?.throwIfAborted()
    await assertGrant(ctx)
    let handle: FileHandle
    try {
        // O_NOFOLLOW_ANY matches openWithoutLinks. An existing name is left untouched.
        handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | 0x20000000, 0o600)
    } catch (error) {
        ctx.abortSignal?.throwIfAborted()
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ImageKeepError('exists')
        throw new ImageKeepError('keep')
    }
    try {
        const { bytesWritten } = await handle.write(bytes)
        if (bytesWritten !== bytes.length) throw new ImageKeepError('keep')
    } finally { await handle.close() }
    const pinned = await openWithoutLinks(target)
    try {
        const info = await pinned.stat({ bigint: true })
        if (!info.isFile() || info.nlink !== 1n || info.size !== BigInt(bytes.length)) throw new ImageKeepError('keep')
        const identity = `${info.dev}:${info.ino}`
        if (!IDENTITY.test(identity)) throw new ImageKeepError('keep')
        const current = await realpath(target)
        if (!staysInside(workspace, current) || basename(current) !== name) throw new ImageKeepError('keep')
        await assertGrant(ctx)
        return { kind: 'file', files: [{ path: rel, name, size: bytes.length, scope: 'agent', identity }] }
    } finally { await pinned.close() }
}

async function keepGeneratedImage(ctx: DesktopCodexImageContext, item: ImageGenerationItem): Promise<FileCard> {
    if (ctx.provider !== 'codex') throw new ImageKeepError('adapter')
    if (!exactRun(ctx)) throw new ImageKeepError('run')
    await assertGrant(ctx)
    let bytes: Buffer | undefined
    if (typeof item.savedPath === 'string' && item.savedPath) {
        if (!ctx.runRoot) {
            if (typeof item.result !== 'string' || !item.result) throw new ImageKeepError('outside')
        } else {
            try { bytes = await readApproved(ctx, item.savedPath) }
            catch (error) {
                ctx.abortSignal?.throwIfAborted()
                if (typeof item.result !== 'string' || !item.result) throw error
            }
        }
    }
    if (!bytes) {
        if (typeof item.result !== 'string' || !item.result) throw new ImageKeepError('nodata')
        bytes = inlineBytes(item.result)
    }
    if (!extensionOf(bytes)) throw new ImageKeepError('unsupported')
    await assertGrant(ctx)
    return writeGenerated(ctx, item.id, bytes)
}

function unavailable(part: ToolPart, code: keyof typeof MESSAGES): ToolPart {
    return { ...part, result: { error: MESSAGES[code] }, isError: true }
}

/** Rewrite one already-named image_generation part. Other tools are unchanged. Unsupported adapters copy nothing. */
export async function rewriteDesktopCodexImagePart<Part extends { type: string }>(
    ctx: DesktopCodexImageContext,
    part: Part,
    imageCalls: Set<string> = new Set(),
): Promise<Part> {
    const item = part as Part & ToolPart
    if (item.type === 'tool-input-delta') {
        if (!item.id || !imageCalls.has(item.id) || typeof item.delta !== 'string') return part
        return { ...part, delta: imageInput(imageItem(item.delta)) }
    }
    if (item.toolName !== IMAGE_GENERATION_TOOL) return part
    if (item.type === 'tool-input-start' && item.id) {
        imageCalls.add(item.id)
        return part
    }
    if (item.type === 'tool-call' && typeof item.input === 'string') return { ...part, input: imageInput(imageItem(item.input)) }
    if (item.type !== 'tool-result') return part
    if (item.preliminary) return { ...part, result: {} }
    if (ctx.provider !== 'codex') return unavailable(item, 'adapter') as Part
    if (!exactRun(ctx)) return unavailable(item, 'run') as Part
    const generated = imageItem(item.result)
    if (!generated) return unavailable(item, 'nodata') as Part
    if (generated.status === 'failed' || item.isError) return { ...part, result: { error: failureText(generated.failure) }, isError: true }
    try {
        return { ...part, result: await keepGeneratedImage(ctx, generated), isError: false }
    } catch (error) {
        ctx.abortSignal?.throwIfAborted()
        const message = error instanceof ImageKeepError ? error.message : MESSAGES.keep
        return { ...part, result: { error: message }, isError: true }
    }
}

export function createDesktopCodexImageMiddleware(ctx: DesktopCodexImageContext): LanguageModelMiddleware {
    return {
        specificationVersion: 'v3',
        async wrapStream({ doStream }) {
            const result = await doStream()
            type Part = typeof result.stream extends ReadableStream<infer P> ? P : never
            const imageCalls = new Set<string>()
            return {
                ...result,
                stream: result.stream.pipeThrough(new TransformStream<Part, Part>({
                    async transform(part, controller) {
                        controller.enqueue(await rewriteDesktopCodexImagePart(ctx, part, imageCalls))
                    },
                })),
            }
        },
        async wrapGenerate({ doGenerate }) {
            const result = await doGenerate()
            const imageCalls = new Set<string>()
            const content: Array<typeof result.content[number]> = []
            for (const part of result.content) content.push(await rewriteDesktopCodexImagePart(ctx, part, imageCalls))
            return { ...result, content }
        },
    }
}
