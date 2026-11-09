import { saveDesktopResultFile } from './result-file-save'

export type SharedMedia = { bytes: Uint8Array; contentType: string; identity: string; name: string }

const deadline = (signal?: AbortSignal) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)])

export function sharedMediaUrl(path: string, kind: 'image' | 'audio' | 'video' | 'pdf' | 'download', identity?: string): string {
    const query = new URLSearchParams({ path })
    if (identity) query.set('identity', identity)
    if (kind === 'download') query.set('download', '1')
    return `/api/desktop/shared-files/${kind === 'pdf' ? 'pdf' : 'media'}?${query}`
}

async function errorOf(response: Response): Promise<Error> {
    const body = await response.json().catch(() => null) as { error?: unknown } | null
    return new Error(typeof body?.error === 'string' ? body.error : 'This shared file could not be opened.')
}

export async function readDesktopSharedMedia(path: string, kind: 'image' | 'audio' | 'video' | 'download', identity?: string, signal?: AbortSignal): Promise<SharedMedia> {
    const response = await fetch(sharedMediaUrl(path, kind, identity), { cache: 'no-store', signal: deadline(signal) })
    if (!response.ok) throw await errorOf(response)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const hash = response.headers.get('x-rerun-shared-sha256')
    if (!hash || identity !== undefined && hash !== identity) throw new Error('This shared file could not be confirmed.')
    return { bytes, contentType: response.headers.get('content-type') ?? 'application/octet-stream', identity: hash, name: path.split('/').filter(Boolean).at(-1) ?? path }
}

export async function saveDesktopSharedFile(path: string, name: string, identity: string | undefined, signal?: AbortSignal): Promise<boolean> {
    const file = await readDesktopSharedMedia(path, 'download', identity, signal)
    signal?.throwIfAborted()
    return saveDesktopResultFile(name, file.bytes)
}

export async function readDesktopSharedPdfText(path: string, sha256: string, signal?: AbortSignal): Promise<unknown> {
    const query = new URLSearchParams({ path, sha256 })
    const response = await fetch(`/api/desktop/shared-files/pdf-text?${query}`, { cache: 'no-store', signal: deadline(signal) })
    if (!response.ok) throw await errorOf(response)
    return response.json()
}
