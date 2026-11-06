import { CARD_MAX_AUDIO_BYTES, CARD_MAX_IMAGE_BYTES, CARD_MAX_VIDEO_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES } from '@rerun/contracts'

/** Download tiles and shared PDFs. Matches the engine card cap. Not part of the shared card schema. */
export const DESKTOP_RESULT_FILE_BINARY_MAX_BYTES = 16 * 1024 * 1024
export const DESKTOP_RESULT_FILE_IDENTITY = /^\d{1,24}:\d{1,24}$/
const PART = /^[^/\\.\0][^/\\\0]{0,240}$/
const IMAGE = /\.(?:png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i
const RASTER = /\.(?:png|jpe?g|gif|webp)$/i
const AUDIO = /\.(?:wav|mp3|m4a|ogg|flac)$/i
const VIDEO = /\.(?:mp4|webm|mov|m4v)$/i
const PDF = /\.pdf$/i
const TEXT = /\.(?:txt|md)$/i

export type DesktopResultFileScope = 'agent' | 'shared'
export type DesktopResultFileTicket = {
    agentId: string
    path: string
    name: string
    scope: DesktopResultFileScope
    identity: string
    size: number
}

const visible = (path: string) => path.length > 0 && path.length <= 4096 && !/[\\\p{Cc}]/u.test(path)
    && path.split('/').every(part => PART.test(part))

/** Basename only. Rejects quotes, semicolons, controls, slashes and a leading dot. Does not rewrite the name. */
export function desktopResultFileName(name: string): string | undefined {
    if (name.length < 1 || name.length > 255 || name.startsWith('.') || /[\\/\p{Cc}"';]/u.test(name)) return undefined
    return name
}

export function desktopResultFileDisposition(name: string): string | undefined {
    const safe = desktopResultFileName(name)
    if (!safe) return undefined
    const star = `UTF-8''${encodeURIComponent(safe)}`
    if (/^[\x20-\x7E]+$/.test(safe)) return `attachment; filename="${safe}"; filename*=${star}`
    return `attachment; filename*=${star}`
}

export function desktopResultFileRoute(agentId: string): string {
    return `/api/desktop/coworkers/${encodeURIComponent(agentId)}/result-files`
}

function kindCap(path: string): number {
    if (IMAGE.test(path)) return CARD_MAX_IMAGE_BYTES
    if (AUDIO.test(path)) return CARD_MAX_AUDIO_BYTES
    if (VIDEO.test(path)) return CARD_MAX_VIDEO_BYTES
    if (TEXT.test(path)) return DESKTOP_ATTACHMENT_MAX_BYTES
    return DESKTOP_RESULT_FILE_BINARY_MAX_BYTES
}

function allowed(scope: DesktopResultFileScope, path: string): boolean {
    if (!visible(path)) return false
    const preview = IMAGE.test(path) || AUDIO.test(path) || VIDEO.test(path) || PDF.test(path) || TEXT.test(path)
    if (scope === 'agent') return !preview
    return true
}

/** Body fields only. A client filename, URL, root or owner id is rejected rather than ignored. */
export function parseDesktopResultFileBody(agentId: string, value: unknown): DesktopResultFileTicket | undefined {
    if (!agentId || agentId.length > 200 || /[\\/\p{Cc}]/u.test(agentId)) return undefined
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const body = value as Record<string, unknown>
    if (Object.keys(body).some(key => key !== 'path' && key !== 'scope' && key !== 'identity' && key !== 'size')) return undefined
    if (typeof body.path !== 'string' || (body.scope !== 'agent' && body.scope !== 'shared')) return undefined
    if (typeof body.identity !== 'string' || !DESKTOP_RESULT_FILE_IDENTITY.test(body.identity)) return undefined
    if (typeof body.size !== 'number' || !Number.isSafeInteger(body.size) || body.size < 0) return undefined
    if (!allowed(body.scope, body.path)) return undefined
    const name = body.path.split('/').at(-1) ?? ''
    if (!desktopResultFileName(name)) return undefined
    const cap = kindCap(body.path)
    const emptyBlocked = !TEXT.test(body.path)
    if ((emptyBlocked && body.size < 1) || body.size > cap) return undefined
    if (PDF.test(body.path) && body.size > DESKTOP_RESULT_FILE_BINARY_MAX_BYTES) return undefined
    return { agentId, path: body.path, name, scope: body.scope, identity: body.identity, size: body.size }
}

/** Shared SVG, AVIF, ICO, BMP and PDF stay download-only. This process does not convert or parse them. */
export function desktopResultFilePreviewKind(file: { path: string; scope?: string }): 'none' | 'text' | 'image' | 'audio' | 'video' {
    if (file.scope !== 'shared') return 'none'
    if (RASTER.test(file.path)) return 'image'
    if (AUDIO.test(file.path)) return 'audio'
    if (VIDEO.test(file.path)) return 'video'
    if (TEXT.test(file.path)) return 'text'
    return 'none'
}
