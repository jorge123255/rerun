import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { IsolatedScreenRefusal } from './refusal.ts'
import type { ScreenExportArtifact, ScreenNavigate } from './types.ts'
import { PAGE_EXPORT_ROOT } from './export-metadata.ts'

export const EXPORT_HTML_MAX = 1024 * 1024
export const EXPORT_PNG_MAX = 6 * 1024 * 1024
export const EXPORT_EDGE_MAX = 8192
export const EXPORT_PIXELS_MAX = 16_777_216
export const EXPORT_CAPTURE_MS = 15_000
export const NAVIGATION_MAX_MS = 120_000
export const NAVIGATION_DEFAULT_MS = 30_000
const unavailable = () => new IsolatedScreenRefusal('The browser export is invalid or exceeds its limits.', 'refused')

export function exportPath(value: string, kind: ScreenExportArtifact['kind']): string {
    const cache = typeof value === 'string' && kind !== 'screenshot' && value.startsWith(`${PAGE_EXPORT_ROOT}/`)
    const parts = typeof value === 'string' ? value.split('/') : []
    const checked = cache ? parts.slice(2) : parts
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\\\p{Cc}]/u.test(value)
        || checked.some(part => !part || (cache ? part === '.' || part === '..' : part.startsWith('.')) || part.length > (cache ? 200 : 120))
        || !(kind === 'screenshot' ? value.endsWith('.png') : cache
            ? new RegExp(`\\.browser-[a-f0-9]{32}\\.${kind === 'page-metadata' ? 'meta' : 'html'}\\.txt$`).test(value)
            : value.endsWith(kind === 'page-metadata' ? '.browser.meta.txt' : '.browser.html.txt'))) throw unavailable()
    return value
}

export function navigationOptions(input: ScreenNavigate) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['url', 'links', 'timeoutMs', 'screenshotPath'].includes(key))) throw unavailable()
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
    const errors = Array.isArray(raw.exportErrors) ? raw.exportErrors as Array<{ kind: string }> : []
    if (!Number.isInteger(htmlLength) || (htmlLength as number) < 0 || (htmlLength as number) > EXPORT_HTML_MAX
        || !Number.isInteger(pngLength) || (pngLength as number) < 0 || (pngLength as number) > EXPORT_PNG_MAX
        || (htmlLength as number) + (pngLength as number) !== binary.length
        || (htmlLength === 0 && !errors.some(item => item.kind === 'rendered-html'))
        || (paths.screenshot ? (pngLength === 0 && !errors.some(item => item.kind === 'screenshot')) : pngLength !== 0)) throw unavailable()
    const html = Buffer.from(binary.subarray(0, htmlLength as number))
    try { new TextDecoder('utf-8', { fatal: true }).decode(html) } catch { throw unavailable() }
    if (html.includes(0)) throw unavailable()
    const artifacts: ScreenExportArtifact[] = html.length ? [artifact('rendered-html', paths.html, html)] : []
    if (paths.screenshot && pngLength !== 0) {
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
