export type DesktopSharedEntry = { name: string; type: 'file' | 'dir'; size: number; modified: string }

export type DesktopSharedListing = { path: string; entries: DesktopSharedEntry[]; truncated: boolean }

export type DesktopSharedTextIdentity = { expectedBytes: number; expectedSha256: string }
export type DesktopSharedPreview = { path: string; content: string; size: number; truncated: boolean; offset: number; nextOffset: number | null; editIdentity?: DesktopSharedTextIdentity | null }

const BASE = '/api/desktop/shared-files'
const deadline = (signal?: AbortSignal) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)])

async function parse<T>(response: Response): Promise<T> {
    const body = await response.json().catch(() => null) as { error?: unknown } | null
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Shared files could not be opened.')
    return body as T
}

export async function listDesktopSharedFolder(path: string, signal?: AbortSignal): Promise<DesktopSharedListing> {
    const query = new URLSearchParams({ path })
    const response = await fetch(`${BASE}?${query}`, { cache: 'no-store', signal: deadline(signal) })
    const listing = await parse<{ path: string; entries: { name: string; type: 'file' | 'dir'; size: number; modifiedAt: string }[]; truncated: boolean }>(response)
    return {
        path: listing.path,
        truncated: listing.truncated,
        entries: listing.entries.map(entry => ({ name: entry.name, type: entry.type, size: entry.size, modified: entry.modifiedAt })),
    }
}

export async function readDesktopSharedPreview(path: string, signal?: AbortSignal): Promise<DesktopSharedPreview> {
    const query = new URLSearchParams({ path })
    const response = await fetch(`${BASE}/read?${query}`, { cache: 'no-store', signal: deadline(signal) })
    return parse(response)
}

export async function importDesktopSharedFile(folder: string, file: File, signal?: AbortSignal): Promise<{ path: string; name: string }> {
    const body = new FormData()
    body.set('file', file)
    body.set('path', folder)
    if (file.size > 1024 * 1024) throw new Error('Files can be up to 1 MB.')
    if (!/\.(txt|md)$/i.test(file.name)) throw new Error('Only .txt and .md files can be imported.')
    const response = await fetch(BASE, { method: 'POST', body, signal: deadline(signal) })
    return parse(response)
}

export type DesktopSharedImportResult = { name: string; folder?: string; status: 'created' | 'refused' | 'uncertain'; path?: string; message?: string }

export async function importDesktopSharedFiles(folder: string, files: readonly File[], signal?: AbortSignal): Promise<DesktopSharedImportResult[]> {
    const body = new FormData()
    for (const file of files) body.append('file', file)
    body.set('path', folder)
    const response = await fetch(`${BASE}/batch`, { method: 'POST', body, signal: deadline(signal) })
    return (await parse<{ results: DesktopSharedImportResult[] }>(response)).results
}

export async function renameDesktopSharedFile(path: string, name: string, signal?: AbortSignal): Promise<{ path: string; name: string }> {
    return parse(await fetch(BASE, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, name }), signal: deadline(signal),
    }))
}

export async function replaceDesktopSharedText(workspaceId: number, path: string, content: string, base: DesktopSharedTextIdentity, signal: AbortSignal) {
    const saved = await parse<{ ok: true; workspaceId: number; path: string; editIdentity: DesktopSharedTextIdentity; recoveryPath?: string }>(await fetch(BASE, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, path, content, base }), signal: deadline(signal),
    }))
    if (!saved?.ok || saved.workspaceId !== workspaceId || saved.path !== path || !saved.editIdentity) {
        throw new Error('The shared file save could not be confirmed.')
    }
    return saved
}
