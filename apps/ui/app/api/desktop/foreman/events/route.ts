import { foremanChatRefSchema } from '@rerun/contracts'
import { desktopRoute } from '@/lib/desktop/server/http'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
export const runtime = 'nodejs'
export async function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = foremanChatRefSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
        if (!parsed.success || parsed.data.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Conversation not found.')
        const app = await desktopForeman(runtime), encoder = new TextEncoder()
        const lifetime = AbortSignal.any([request.signal, app.voiceShutdownSignal])
        let close: (() => void) | undefined, timer: ReturnType<typeof setInterval> | undefined
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined, ended = false
        const stop = () => {
            if (ended) return
            ended = true
            close?.(); close = undefined
            if (timer) clearInterval(timer)
            lifetime.removeEventListener('abort', stop)
            try { controller?.close() } catch { /* A cancelled reader already closed its stream. */ }
        }
        const stream = new ReadableStream({
            async start(streamController) {
                controller = streamController
                lifetime.addEventListener('abort', stop, { once: true })
                if (lifetime.aborted) { stop(); return }
                const emit = (value: string) => { if (!ended) try { controller!.enqueue(encoder.encode(value)) } catch { stop() } }
                let unsubscribe: () => void
                try { unsubscribe = await app.subscribe(parsed.data, lifetime, event => emit(`data: ${JSON.stringify(event)}\n\n`)) }
                catch (error) { try { streamController.error(error) } finally { stop() }; return }
                // Shutdown can happen while the binding checks chat ownership. Release
                // that late subscription rather than resurrecting its keepalive timer.
                if (ended || lifetime.aborted) { unsubscribe(); stop(); return }
                close = unsubscribe
                emit(': connected\n\n')
                if (ended) return
                timer = setInterval(() => emit(': keepalive\n\n'), 15_000)
            }, cancel() { stop() },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-store', connection: 'keep-alive' } })
    })
}
