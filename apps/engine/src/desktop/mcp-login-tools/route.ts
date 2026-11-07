import { abortable } from '../web-fetch/transport.ts'
import { createDesktopMcpLoginBackend, type RemoteLoginService } from './backend.ts'

export type McpLoginRoutePorts<Runtime> = {
    authenticate(request: Request): Promise<Runtime>
    service(runtime: Runtime): Promise<RemoteLoginService>
    watchOwner(runtime: Runtime, owner: string): () => void
}

/** Root binds the existing engine authentication, workspace service and owner-generation watcher. */
export function createDesktopMcpLoginRoute<Runtime>(ports: McpLoginRoutePorts<Runtime>) {
    return async (request: Request): Promise<Response> => {
        const headers = { 'Cache-Control': 'no-store' }
        if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers })
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(70_000)])
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        try {
            signal.throwIfAborted()
            const runtime = await abortable(ports.authenticate(request), signal)
            reader = request.body?.getReader()
            if (!reader) throw new Error('Missing request')
            const chunks: Uint8Array[] = []
            let bytes = 0
            const bodySignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)])
            while (true) {
                const chunk = await abortable(reader.read(), bodySignal)
                bodySignal.throwIfAborted()
                if (chunk.done) break
                bytes += chunk.value.byteLength
                if (bytes > 8192) throw new Error('Request exceeds limit')
                chunks.push(chunk.value)
            }
            const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const service = await abortable(ports.service(runtime), signal)
            signal.throwIfAborted()
            // Device fallback intentionally remains unavailable; this route has no effect/custody binding.
            const result = await createDesktopMcpLoginBackend(service, owner => ports.watchOwner(runtime, owner))(raw, signal)
            signal.throwIfAborted()
            return Response.json(result, { headers })
        } catch {
            return Response.json({ error: 'MCP login/status unavailable for this active run. Reconcile any existing sign-in; do not repeat authorization.' }, { status: signal.aborted ? 409 : 400, headers })
        } finally {
            if (reader) await abortable(reader.cancel(), AbortSignal.timeout(1_000)).catch(() => {})
        }
    }
}
