import { createHash } from 'node:crypto'
import { assertHttpUrl } from './page.ts'
import type { ScreenExportArtifact, ScreenPage } from './types.ts'

export const PAGE_EXPORT_ROOT = '.rerun/pages'
export const PAGE_METADATA_MAX = 16_384
export const PAGE_RETENTION = { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxOwnedBytes: 200 * 1024 * 1024 } as const
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const fileSafe = (text: string) => text.replace(/[^\w.-]/g, '_')

export function browserPageBase(url: string): string {
    const parsed = new URL(assertHttpUrl(url))
    const segments = parsed.pathname.split('/').slice(1)
    if (segments.at(-1) === '') segments[segments.length - 1] = 'index'
    const safe = segments.map(segment => /^\.*$/.test(segment) ? '_' : fileSafe(segment).slice(0, 80))
    const lossy = !!parsed.search || safe.some((segment, index) => segment !== segments[index])
    if (lossy) safe[safe.length - 1] = `${safe.at(-1)}-${hash(parsed.pathname + parsed.search).slice(0, 8)}`
    const hierarchy = [fileSafe(parsed.host).slice(0, 80), ...safe].join('/')
    return hierarchy.length <= 700 ? hierarchy : `${fileSafe(parsed.host).slice(0, 80)}/page-${hash(url)}`
}

export function browserHtmlPath(url: string, source: { agentId: string; sessionId: string; runId: string; toolCallId: string }): string {
    const attempt = hash(JSON.stringify([source.agentId, source.sessionId, source.runId, source.toolCallId])).slice(0, 32)
    return `${PAGE_EXPORT_ROOT}/${browserPageBase(url)}-${hash(url).slice(0, 16)}.browser-${attempt}.html.txt`
}

export function browserMetadataArtifact(htmlPath: string, url: string, page: ScreenPage, artifacts: ScreenExportArtifact[], savedAt: string): ScreenExportArtifact {
    if (!/^\d{4}-\d\d-\d\dT/.test(savedAt) || !Number.isFinite(Date.parse(savedAt))) throw new Error('Invalid browser export timestamp.')
    const path = htmlPath.replace(/\.html\.txt$/, '.meta.txt')
    const html = artifacts.find(item => item.kind === 'rendered-html')
    const screenshot = artifacts.find(item => item.kind === 'screenshot')
    const bytes = Buffer.from(JSON.stringify({
        url: assertHttpUrl(url),
        views: html ? { browser: { file: html.path, savedAt, status: page.status, finalUrl: page.finalUrl,
            contentType: 'text/html', sha256: html.sha256, byteLength: html.bytes.length } } : {},
        ...(screenshot ? { screenshot: { file: screenshot.path, savedAt, sha256: screenshot.sha256, byteLength: screenshot.bytes.length,
            width: screenshot.width, height: screenshot.height, fullPage: true } } : {}),
    }, null, 2))
    if (bytes.length > PAGE_METADATA_MAX) throw new Error('Browser page metadata exceeds limit.')
    return { kind: 'page-metadata', path, mediaType: 'text/plain', bytes, sha256: hash(bytes.toString('utf8')) }
}
