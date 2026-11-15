import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { EXTERNAL_MCP_PATH } from '@rerun/contracts'

export type ExternalMcpSocket = {
    origin: string
    close(): Promise<void>
}

const BODY_CAP = 1_000_000

/**
 * Binds loopback only. `preferredPort` is the port this workspace used last, so the address a
 * client was given keeps working; when another program holds it, any free port is used instead.
 */
export async function openExternalMcpListener(onRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>, preferredPort?: number): Promise<ExternalMcpSocket> {
    const server = createServer((request, response) => {
        void onRequest(request, response).catch(() => {
            if (!response.headersSent) response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            if (!response.writableEnded) response.end(JSON.stringify({ ok: false, code: 'uncertain', message: 'The external request outcome is unknown. It was not started again.' }))
        })
    })
    const bind = (port: number) => new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
            server.off('error', reject)
            resolve()
        })
    })
    const preferred = Number.isInteger(preferredPort) && preferredPort! >= 1024 && preferredPort! <= 65535 ? preferredPort! : 0
    try {
        await bind(preferred)
    } catch (error) {
        if (!preferred) throw error
        await bind(0)
    }
    const address = server.address()
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || !address.port) {
        server.close()
        throw new Error('External MCP listener did not bind to loopback.')
    }
    let closing: Promise<void> | null = null
    let closed = false
    return {
        origin: `http://127.0.0.1:${address.port}`,
        close() {
            if (closed) return Promise.resolve()
            if (closing) return closing
            const work = new Promise<void>((resolve, reject) => {
                // Stop accepting before destroying sockets so a new connection cannot slip
                // between the two operations. Concurrent/retried cleanup shares the ACK.
                server.close(error => {
                    if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
                    else { closed = true; resolve() }
                })
                server.closeAllConnections?.()
            })
            closing = work
            void work.catch(() => { if (closing === work) closing = null })
            return work
        },
    }
}

export async function readExternalMcpBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > BODY_CAP) throw Object.assign(new Error('External MCP request is too large.'), { status: 413 })
        chunks.push(buffer)
    }
    if (!chunks.length) return null
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function externalMcpPath(url: string | undefined): { path: string; search: string } {
    const parsed = new URL(url ?? EXTERNAL_MCP_PATH, 'http://127.0.0.1')
    return { path: parsed.pathname, search: parsed.search }
}
