import { extname, isAbsolute } from 'node:path'
import type { ModelMessage } from 'ai'
import type { RunContext } from '../../runtime/context.js'
import { openWithoutLinks } from '../open-without-links.js'
import { workspacePath } from '../workspace-read.js'

const MEDIA_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
export const DESKTOP_VISION_MAX_EDGE = 2048
export const DESKTOP_VISION_MAX_BYTES = 4 * 1024 * 1024
export const DESKTOP_VISION_INPUT_MAX_BYTES = 16 * 1024 * 1024
const IMAGE_OPTIONS = { limitInputChannels: 4, failOn: 'warning' as const }
const ANIMATED_PIXEL_LIMIT = 16_777_216
const DECODE_TIMEOUT_SECONDS = 5

class VisionFileError extends Error {}
const unavailable = () => new VisionFileError('This image is unavailable in this coworker’s workspace.')

export function desktopVisionPathAllowed(imagePath: string): boolean {
    if (!imagePath || isAbsolute(imagePath) || imagePath.includes('\0') || imagePath.includes('\\')) return false
    return imagePath.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.toLowerCase().startsWith('.rerun'))
}

async function readVisionFile(agentId: string, imagePath: string): Promise<Buffer> {
    try {
        const target = await workspacePath(agentId, imagePath)
        const file = await openWithoutLinks(target)
        try {
            const before = await file.stat({ bigint: true })
            if (!before.isFile() || before.nlink !== 1n) throw unavailable()
            if (before.size > DESKTOP_VISION_INPUT_MAX_BYTES) {
                throw new VisionFileError(`Image exceeds the ${DESKTOP_VISION_INPUT_MAX_BYTES / 1024 / 1024} MiB input limit: ${imagePath}`)
            }
            const bytes = Buffer.alloc(Number(before.size))
            let length = 0
            while (length < bytes.length) {
                const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
                if (!bytesRead) break
                length += bytesRead
            }
            if (length !== bytes.length) throw unavailable()

            // Verify the requested name still refers to the same unchanged, single-link file.
            const current = await openWithoutLinks(target)
            try {
                const after = await current.stat({ bigint: true })
                if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
                    || after.nlink !== 1n || after.ctimeNs !== before.ctimeNs) throw unavailable()
            } finally { await current.close() }
            return bytes
        } finally { await file.close() }
    } catch (error) {
        if (error instanceof VisionFileError) throw error
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new VisionFileError(`Image not found: ${imagePath}`)
        throw unavailable()
    }
}

export async function resolveDesktopVisionImage(agentId: string, imagePath: string): Promise<{ image: Buffer; mediaType: string }> {
    if (!desktopVisionPathAllowed(imagePath)) throw new Error('This image path is unavailable.')
    const mediaType = MEDIA_TYPES[extname(imagePath).toLowerCase()]
    if (!mediaType) throw new Error(`Unsupported image type: ${imagePath}`)
    const image = await readVisionFile(agentId, imagePath)
    const { default: sharp } = await import('sharp')
    try {
        const decoder = sharp(image, { ...IMAGE_OPTIONS, animated: true }).timeout({ seconds: DECODE_TIMEOUT_SECONDS })
        const meta = await decoder.metadata()
        if (!meta.width || !meta.height || meta.format !== mediaType.slice('image/'.length)) throw new Error('Invalid image format')
        const height = meta.pageHeight ?? meta.height
        const pages = meta.pages ?? 1
        if (pages > 1 && meta.width * height * pages > ANIMATED_PIXEL_LIMIT) throw new Error('Too many image pixels')
        const preserve = Math.max(meta.width, height) <= DESKTOP_VISION_MAX_EDGE
            && image.byteLength <= DESKTOP_VISION_MAX_BYTES
        // Metadata may succeed with a truncated payload. Decode all frames of preserved images.
        if (preserve || pages > 1) await decoder.raw().toBuffer()
        if (preserve) return { image, mediaType }
        const reduced = await sharp(image, IMAGE_OPTIONS).timeout({ seconds: DECODE_TIMEOUT_SECONDS }).rotate()
            .resize(DESKTOP_VISION_MAX_EDGE, DESKTOP_VISION_MAX_EDGE, { fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: false })
            .webp({ quality: 85 }).toBuffer()
        return { image: reduced, mediaType: 'image/webp' }
    } catch {
        throw new Error('The file is not a readable image within the supported size limits.')
    }
}

export async function desktopVisionImageMessages(ctx: RunContext, imagePath: string, prompt: string): Promise<ModelMessage[]> {
    const { image, mediaType } = await resolveDesktopVisionImage(ctx.agent.id, imagePath)
    ctx.abortSignal?.throwIfAborted()
    return [{ role: 'user', content: [{ type: 'image', image, mediaType }, { type: 'text', text: prompt }] }]
}
