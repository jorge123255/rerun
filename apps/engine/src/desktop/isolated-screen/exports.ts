import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { IsolatedScreenRefusal } from './refusal.js'
import type { ScreenExportArtifact, ScreenNavigate } from './types.js'

export const EXPORT_HTML_MAX = 1024 * 1024
export const EXPORT_PNG_MAX = 6 * 1024 * 1024
export const EXPORT_EDGE_MAX = 8192
export const EXPORT_PIXELS_MAX = 16_777_216
export const EXPORT_CAPTURE_MS = 15_000
export const NAVIGATION_MAX_MS = 120_000
export const NAVIGATION_DEFAULT_MS = 30_000
const unavailable = () => new IsolatedScreenRefusal('The browser export is invalid or exceeds its limits.', 'refused')

export function exportPath(value: string, kind: ScreenExportArtifact['kind']): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\\\p{Cc}]/u.test(value)
        || value.split('/').some(part => !part || part.startsWith('.') || part.length > 120)
        || !(kind === 'screenshot' ? value.endsWith('.png') : value.endsWith('.browser.html.txt'))) throw unavailable()
    return value
}

export function navigationOptions(input: ScreenNavigate) {
    const timeoutMs = input.timeoutMs ?? NAVIGATION_DEFAULT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > NAVIGATION_MAX_MS
        || input.links !== undefined && typeof input.links !== 'boolean') throw unavailable()
    if (input.screenshotPath !== undefined) exportPath(input.screenshotPath, 'screenshot')
    return { timeoutMs, links: input.links === true, screenshot: input.screenshotPath !== undefined }
}

function artifact(kind: ScreenExportArtifact['kind'], path: string, bytes: Buffer, dimensions?: { width: number; height: number }): ScreenExportArtifact {
    return { kind, path: exportPath(path, kind), bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
        mediaType: kind === 'screenshot' ? 'image/png' : 'text/plain', ...dimensions }
}

export async function decodePageExports(raw: Record<string, unknown>, binary: Buffer, paths: { html: string; screenshot?: string }, signal: AbortSignal): Promise<ScreenExportArtifact[]> {
    signal.throwIfAborted()
    const htmlLength = raw.htmlBytes
    const pngLength = raw.screenshotBytes
    if (!Number.isInteger(htmlLength) || (htmlLength as number) < 1 || (htmlLength as number) > EXPORT_HTML_MAX
        || !Number.isInteger(pngLength) || (pngLength as number) < 0 || (pngLength as number) > EXPORT_PNG_MAX
        || (htmlLength as number) + (pngLength as number) !== binary.length
        || (paths.screenshot ? (pngLength as number) === 0 : pngLength !== 0)) throw unavailable()
    const html = Buffer.from(binary.subarray(0, htmlLength as number))
    try { new TextDecoder('utf-8', { fatal: true }).decode(html) } catch { throw unavailable() }
    if (html.includes(0)) throw unavailable()
    const artifacts = [artifact('rendered-html', paths.html, html)]
    if (paths.screenshot) {
        const png = binary.subarray(htmlLength as number)
        const width = raw.screenshotWidth, height = raw.screenshotHeight
        if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height)
            || width < 1 || height < 1 || width > EXPORT_EDGE_MAX || height > EXPORT_EDGE_MAX || width * height > EXPORT_PIXELS_MAX
            || png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR'
            || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) throw unavailable()
        let offset = 8, ended = false
        while (offset + 12 <= png.length) {
            const length = png.readUInt32BE(offset)
            const type = png.toString('ascii', offset + 4, offset + 8)
            if (length > png.length - offset - 12 || ['acTL', 'fcTL', 'fdAT'].includes(type)) throw unavailable()
            offset += length + 12
            if (type === 'IEND') { ended = length === 0 && offset === png.length; break }
        }
        if (!ended) throw unavailable()
        const { default: sharp } = await import('sharp')
        signal.throwIfAborted()
        const clean = await sharp(png, { failOn: 'warning', limitInputPixels: EXPORT_PIXELS_MAX })
            .timeout({ seconds: 5 }).png().toBuffer({ resolveWithObject: true })
        signal.throwIfAborted()
        if (clean.info.width !== width || clean.info.height !== height || clean.data.length > EXPORT_PNG_MAX) throw unavailable()
        artifacts.push(artifact('screenshot', paths.screenshot, clean.data, { width, height }))
    }
    return artifacts
}
