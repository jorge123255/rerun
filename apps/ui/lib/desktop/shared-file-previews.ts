const deadline = (signal?: AbortSignal) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)])

export function sharedMediaUrl(path: string, kind: 'image' | 'audio' | 'video' | 'pdf'): string {
    return `/api/desktop/shared-files/${kind === 'pdf' ? 'pdf' : 'media'}?${new URLSearchParams({ path })}`
}

async function errorOf(response: Response): Promise<Error> {
    const body = await response.json().catch(() => null) as { error?: unknown } | null
    return new Error(typeof body?.error === 'string' ? body.error : 'This shared file could not be opened.')
}

export async function readDesktopSharedPdfText(path: string, sha256: string, signal?: AbortSignal): Promise<unknown> {
    const query = new URLSearchParams({ path, sha256 })
    const response = await fetch(`/api/desktop/shared-files/pdf-text?${query}`, { cache: 'no-store', signal: deadline(signal) })
    if (!response.ok) throw await errorOf(response)
    return response.json()
}
