import { lstat, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import type { ModelMessage } from 'ai'
import { resolveInWorkspace } from '../../tools/sandbox.js'
import { CLI_PROVIDERS } from '../../agents/providers.js'
import type { RunContext } from '../../runtime/context.js'

const MEDIA_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
export const DESKTOP_VISION_MAX_EDGE = 2048
export const DESKTOP_VISION_MAX_BYTES = 4 * 1024 * 1024
export const DESKTOP_VISION_INPUT_MAX_BYTES = 16 * 1024 * 1024

export function desktopVisionPathAllowed(imagePath: string): boolean {
    if (!imagePath || isAbsolute(imagePath) || imagePath.includes('\0') || imagePath.includes('\\')) return false
    return imagePath.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.toLowerCase().startsWith('.rerun'))
}

export async function resolveDesktopVisionImage(agentId: string, imagePath: string): Promise<{ target: string; mediaType: string }> {
    if (!desktopVisionPathAllowed(imagePath)) throw new Error('This image path is unavailable.')
    const target = resolveInWorkspace(agentId, imagePath)
    if (!existsSync(target)) throw new Error(`Image not found: ${imagePath}`)
    const mediaType = MEDIA_TYPES[extname(imagePath).toLowerCase()]
    if (!mediaType) throw new Error(`Unsupported image type: ${imagePath}`)
    const info = await lstat(target)
    if (info.isSymbolicLink() || !info.isFile() || info.size > DESKTOP_VISION_INPUT_MAX_BYTES) throw new Error(`Image exceeds the ${DESKTOP_VISION_INPUT_MAX_BYTES / 1024 / 1024} MiB input limit: ${imagePath}`)
    return { target, mediaType }
}

async function downscaleForVision(image: Buffer, mediaType: string): Promise<{ image: Buffer; mediaType: string }> {
    const { default: sharp } = await import('sharp')
    const { width = 0, height = 0 } = await sharp(image).metadata()
    if (!width || !height) throw new Error('The file is not a readable image.')
    if (Math.max(width, height) <= DESKTOP_VISION_MAX_EDGE && image.byteLength <= DESKTOP_VISION_MAX_BYTES) return { image, mediaType }
    const reduced = await sharp(image).rotate().resize(DESKTOP_VISION_MAX_EDGE, DESKTOP_VISION_MAX_EDGE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer()
    return { image: reduced, mediaType: 'image/webp' }
}

export async function desktopVisionImageMessages(ctx: RunContext, imagePath: string, prompt: string): Promise<ModelMessage[]> {
    const { target, mediaType } = await resolveDesktopVisionImage(ctx.agent.id, imagePath)
    if (CLI_PROVIDERS.has(ctx.agent.resolved.provider)) {
        return [{ role: 'user', content: `Open the image file at ${target} with your file reader, then answer about what it shows and nothing else.\n\n${prompt}` }]
    }
    const sent = await downscaleForVision(await readFile(target), mediaType)
    return [{ role: 'user', content: [{ type: 'image', image: sent.image, mediaType: sent.mediaType }, { type: 'text', text: prompt }] }]
}
