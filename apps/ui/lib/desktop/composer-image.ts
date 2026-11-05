import { z } from 'zod'
import { DESKTOP_IMAGE_MAX_BYTES, DESKTOP_IMAGE_MAX_EDGE, DESKTOP_IMAGE_MAX_PIXELS } from './server/image-bytes'

export type DesktopImageUploadStatus = 'queued' | 'importing' | 'error' | 'unresolved'

export const DESKTOP_IMAGE_ATTACHMENT_MAX_FILES = 4
export const DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES = DESKTOP_IMAGE_MAX_BYTES
export const DESKTOP_IMAGE_ATTACHMENT_TOTAL_MAX_BYTES = 16 * 1024 * 1024
export const DESKTOP_IMAGE_UPLOAD_ACCEPT = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp'

export type DesktopImageKind = 'png' | 'jpeg' | 'webp'
export type DesktopImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp'

const MEDIA_TYPE: Record<DesktopImageKind, DesktopImageMediaType> = {
    png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp',
}
const KIND_EXT: Record<DesktopImageKind, RegExp> = {
    png: /\.png$/i, jpeg: /\.jpe?g$/i, webp: /\.webp$/i,
}

/** The durable, content-addressed identity of one imported image. `sha256` names the private
 * snapshot bytes; `path` is only where the user-visible copy lives in this coworker's Files. */
export const desktopImageSnapshotSchema = z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    name: z.string().min(1).max(255),
    path: z.string().min(1).max(4096),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    width: z.number().int().min(1).max(DESKTOP_IMAGE_MAX_EDGE),
    height: z.number().int().min(1).max(DESKTOP_IMAGE_MAX_EDGE),
    byteLength: z.number().int().min(1).max(DESKTOP_IMAGE_MAX_BYTES),
}).strict()
export type DesktopImageSnapshot = z.infer<typeof desktopImageSnapshotSchema>

/** One ordered composer attachment: a text workspace path or an imported image snapshot.
 * The array order is the order the user picked, across both kinds. */
export type DesktopComposerAttachmentItem =
    | { type: 'text'; path: string }
    | { type: 'image'; image: DesktopImageSnapshot }

export type DesktopImageUploadItem = {
    id: string
    name: string
    size: number
    status: DesktopImageUploadStatus
    error: string | null
    previewUrl: string | null
}

export type DesktopImageRejection = { file: File; reason: string }
export type DesktopImagePreflight = {
    accepted: File[]
    rejected: DesktopImageRejection[]
    blockers: string[]
}

export type DesktopImageImport =
    | { ok: true; image: DesktopImageSnapshot }
    | { ok: false; kind: 'rejected' | 'ambiguous'; message: string }

const IMPORT_URL = (agentId: string) => `/api/desktop/agents/${encodeURIComponent(agentId)}/images`
const AMBIGUOUS_MESSAGE = 'The import result could not be confirmed. Check Files before attaching this image again.'

export function desktopImageKindForName(name: string): DesktopImageKind | null {
    if (KIND_EXT.png.test(name)) return 'png'
    if (KIND_EXT.jpeg.test(name)) return 'jpeg'
    if (KIND_EXT.webp.test(name)) return 'webp'
    return null
}

export function desktopImageMediaType(kind: DesktopImageKind): DesktopImageMediaType {
    return MEDIA_TYPE[kind]
}

function hasMagic(bytes: Uint8Array, kind: DesktopImageKind): boolean {
    if (kind === 'png') return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    if (kind === 'jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
}

function imageNameProblem(name: string): string | null {
    if (!name || new TextEncoder().encode(name).length > 255 || name.includes('/') || name.includes('\\') || name.includes('\0') || name.startsWith('.') || /\p{Cc}/u.test(name)) {
        return 'That file name can’t be imported.'
    }
    if (!desktopImageKindForName(name)) return 'Only .png, .jpg, and .webp images can be attached.'
    return null
}

async function decodeDimensions(file: File): Promise<{ width: number; height: number } | null> {
    if (typeof createImageBitmap !== 'function') return null
    try {
        const bitmap = await createImageBitmap(file)
        const size = { width: bitmap.width, height: bitmap.height }
        bitmap.close()
        return size
    } catch {
        return null
    }
}

/**
 * Validates a picked batch against the image budget before any import runs: per-file 8 MiB,
 * 8192 px edges, 16 MP pixels, four files and a 16 MiB aggregate. Attached snapshots and
 * in-flight uploads reserve their slots first. The server re-validates every byte; this pass
 * only refuses what can never succeed and gives each file a readable reason.
 */
export async function preflightDesktopImages(input: {
    files: readonly File[]
    attached: readonly DesktopImageSnapshot[]
    pending: readonly { size: number; status: DesktopImageUploadStatus }[]
}): Promise<DesktopImagePreflight> {
    const blockers: string[] = []
    const attachedBytes = input.attached.reduce((sum, image) => sum + image.byteLength, 0)
    if (input.attached.some(image => image.byteLength > DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES)) {
        blockers.push('An attached image is too large. Remove it before adding images.')
    }
    if (blockers.length) return { accepted: [], rejected: [], blockers }

    const reserved = input.pending.filter(item => item.status === 'queued' || item.status === 'importing')
    let slots = DESKTOP_IMAGE_ATTACHMENT_MAX_FILES - input.attached.length - reserved.length
    let bytesLeft = DESKTOP_IMAGE_ATTACHMENT_TOTAL_MAX_BYTES - attachedBytes - reserved.reduce((sum, item) => sum + item.size, 0)

    const accepted: File[] = []
    const rejected: DesktopImageRejection[] = []
    for (const file of input.files) {
        const nameProblem = imageNameProblem(file.name)
        if (nameProblem) {
            rejected.push({ file, reason: nameProblem })
            continue
        }
        const kind = desktopImageKindForName(file.name)!
        if (file.size < 1 || file.size > DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES) {
            rejected.push({ file, reason: `Images can be up to ${DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES / 1024 / 1024} MiB.` })
            continue
        }
        if (slots <= 0) {
            rejected.push({ file, reason: `You can attach up to ${DESKTOP_IMAGE_ATTACHMENT_MAX_FILES} images.` })
            continue
        }
        if (file.size > bytesLeft) {
            rejected.push({ file, reason: `Images must be ${DESKTOP_IMAGE_ATTACHMENT_TOTAL_MAX_BYTES / 1024 / 1024} MiB or smaller in total.` })
            continue
        }
        const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
        if (!hasMagic(head, kind)) {
            rejected.push({ file, reason: `“${file.name}” is not a valid ${kind === 'jpeg' ? 'JPEG' : kind.toUpperCase()} image.` })
            continue
        }
        const dimensions = await decodeDimensions(file)
        if (dimensions && (dimensions.width > DESKTOP_IMAGE_MAX_EDGE || dimensions.height > DESKTOP_IMAGE_MAX_EDGE
            || BigInt(dimensions.width) * BigInt(dimensions.height) > BigInt(DESKTOP_IMAGE_MAX_PIXELS))) {
            rejected.push({ file, reason: 'This image is too large to attach.' })
            continue
        }
        accepted.push(file)
        slots -= 1
        bytesLeft -= file.size
    }
    return { accepted, rejected, blockers }
}

/** Files carried by a picker change, drop, or paste. Clipboard drops surface as DataTransferItem
 * lists, so both shapes are read; non-image items are left for the text upload path. */
export function desktopImageFilesFromDataTransfer(data: DataTransfer | null): File[] {
    if (!data) return []
    const files: File[] = []
    const seen = new Set<File>()
    const add = (file: File | null) => {
        if (file && !seen.has(file) && desktopImageKindForName(file.name)) {
            seen.add(file)
            files.push(file)
        }
    }
    for (const item of Array.from(data.items ?? [])) {
        if (item.kind === 'file') add(item.getAsFile())
    }
    for (const file of Array.from(data.files ?? [])) add(file)
    return files
}

/**
 * One create-only image import through the desktop images route. The route never overwrites,
 * so a 4xx is a definitive refusal while anything else — a dropped connection, a 5xx, a success
 * body we cannot read — leaves the outcome genuinely unknown and reported as 'ambiguous',
 * never retried silently and never counted as an attachment.
 */
export async function importDesktopImage(agentId: string, file: File, signal?: AbortSignal): Promise<DesktopImageImport> {
    const form = new FormData()
    form.set('path', '')
    form.set('file', file)
    const response = await fetch(IMPORT_URL(agentId), { method: 'POST', body: form, signal })
    if (response.status === 201) {
        const body = await response.json().catch(() => null)
        const image = desktopImageSnapshotSchema.safeParse(body?.image)
        if (image.success && typeof body?.path === 'string' && typeof body?.name === 'string') {
            return { ok: true, image: { ...image.data, path: body.path, name: body.name } }
        }
        return { ok: false, kind: 'ambiguous', message: AMBIGUOUS_MESSAGE }
    }
    if (response.status >= 400 && response.status < 500) {
        const body = await response.json().catch(() => null)
        return { ok: false, kind: 'rejected', message: typeof body?.error === 'string' && body.error ? body.error : `Could not import “${file.name}”.` }
    }
    return { ok: false, kind: 'ambiguous', message: AMBIGUOUS_MESSAGE }
}

/** Request-ready image attachments for the chat send. The UI server resolves each snapshot to
 * bytes before calling this; the engine turns each entry into a provider image part. The
 * `sha256` stays in the record so a resolved payload can be checked against the pinned bytes. */
export function desktopImageRequestAttachments(images: readonly {
    image: DesktopImageSnapshot
    dataBase64: string
}[]): { name: string; mediaType: DesktopImageMediaType; width: number; height: number; byteLength: number; sha256: string; dataBase64: string }[] {
    return images.map(({ image, dataBase64 }) => ({
        name: image.name,
        mediaType: image.mediaType,
        width: image.width,
        height: image.height,
        byteLength: image.byteLength,
        sha256: image.sha256,
        dataBase64,
    }))
}

/** AI SDK `file` parts for the engine's user message, in attachment order. Codex's app-server
 * provider writes each part's bytes to its own temp file and sends a `localImage` item, so no
 * host path, workspace path, or URL ever reaches the model. */
export function desktopImageProviderParts(images: readonly {
    name: string
    mediaType: DesktopImageMediaType
    data: Uint8Array | string
}[]): { type: 'file'; data: Uint8Array | string; mediaType: DesktopImageMediaType; filename: string }[] {
    return images.map(image => ({
        type: 'file' as const,
        data: image.data,
        mediaType: image.mediaType,
        filename: image.name,
    }))
}
