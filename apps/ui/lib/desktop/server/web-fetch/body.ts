import type { IncomingMessage } from 'node:http'

export const MAX_BYTES = 1_000_000
const TEXT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/xml', 'text/xml'])

// Cancellation destroys the stream even when it has stopped delivering chunks. Never buffer
// the entire response before checking its actual byte count, or trust Content-Length alone.
export async function readTextBody(response: IncomingMessage, signal: AbortSignal): Promise<{ body: string; bytes: number; contentType: string }> {
    const abort = () => response.destroy(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    const chunks: Buffer[] = []
    let bytes = 0
    try {
        signal.throwIfAborted()
        const contentType = response.headers['content-type'] ?? ''
        const mime = contentType.split(';')[0].trim().toLowerCase()
        if (!TEXT_TYPES.has(mime)) throw new Error(`Unsupported content type: ${mime || 'missing'}`)
        if (response.headers['content-encoding'] && response.headers['content-encoding'].trim().toLowerCase() !== 'identity') throw new Error('Compressed responses are not supported')
        const declared = response.headers['content-length']
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new Error('Response exceeds byte limit')
        const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? 'utf-8'
        const decoder = new TextDecoder(charset)
        for await (const chunk of response) {
            signal.throwIfAborted()
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            bytes += buffer.byteLength
            if (bytes > MAX_BYTES) throw new Error('Response exceeds byte limit')
            chunks.push(buffer)
        }
        signal.throwIfAborted()
        return { body: decoder.decode(Buffer.concat(chunks, bytes)), bytes, contentType }
    } finally {
        signal.removeEventListener('abort', abort)
        response.destroy()
    }
}
