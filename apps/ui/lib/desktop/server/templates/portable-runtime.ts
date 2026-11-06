import 'server-only'
import { request } from '@/lib/engine/client'
import { openDesktopDatabase } from '../database'
import { engineOf } from '../settings'
import type { DesktopRuntime } from '../runtime'
import { createDesktopPortableTemplateServer } from './portable-server'
import { DesktopHttpError } from '../auth'

export async function readPortableRequest(request: Request): Promise<unknown> {
    if (!request.body) throw new DesktopHttpError(400, 'Invalid template request')
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
        while (true) {
            request.signal.throwIfAborted()
            const next = await reader.read()
            if (next.done) break
            bytes += next.value.byteLength
            if (bytes > 4096) throw new DesktopHttpError(413, 'Template request is too large')
            chunks.push(next.value)
        }
        request.signal.throwIfAborted()
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new DesktopHttpError(400, 'Invalid template request') }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function openDesktopPortableServer(runtime: DesktopRuntime, signal?: AbortSignal) {
    const engine = engineOf(runtime)
    return createDesktopPortableTemplateServer({
        db: await openDesktopDatabase(runtime.dataRoot), signal,
        engine: {
            get: (path, stop) => request(engine, path, { method: 'GET', cache: 'no-store', signal: stop }, value => value),
            post: (path, body, stop) => request(engine, path, { method: 'POST', body: JSON.stringify(body), cache: 'no-store', signal: stop }, value => value),
        },
    })
}
