const MAX_BYTES = 5_000_000

/** The source fixes the authenticated scope; no URL or credentials are sent to a new window. */
export async function saveDesktopDataExport(url: string, table: string, format: 'csv' | 'json', signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!/^\/api\/desktop\/(?:agents\/[^/]+\/data|shared-data)\/export\?/.test(url)) throw new Error('Invalid database export.')
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal })
    if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(typeof body?.error === 'string' ? body.error : 'Could not export this table.')
    }
    const type = response.headers.get('content-type')?.split(';')[0]?.trim()
    if (type !== (format === 'json' ? 'application/json' : 'text/csv')) {
        await response.body?.cancel()
        throw new Error('The export returned an unexpected file type.')
    }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
        await response.body?.cancel()
        throw new Error('Export exceeds 5 MB. Filter the table and try again.')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('The export was empty.')
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let length = 0
    const abort = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try {
        while (true) {
            signal.throwIfAborted()
            const next = await reader.read()
            signal.throwIfAborted()
            if (next.done) break
            length += next.value.byteLength
            if (length > MAX_BYTES) throw new Error('Export exceeds 5 MB. Filter the table and try again.')
            chunks.push(new Uint8Array(next.value))
        }
    } finally {
        signal.removeEventListener('abort', abort)
        await reader.cancel().catch(() => {})
        reader.releaseLock()
    }
    signal.throwIfAborted()
    const objectUrl = URL.createObjectURL(new Blob(chunks, { type }))
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = `${table.replace(/[\\/\p{Cc}]/gu, '_').slice(0, 120) || 'data'}.${format}`
    document.body.append(anchor)
    try { signal.throwIfAborted(); anchor.click() }
    finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000) }
}
