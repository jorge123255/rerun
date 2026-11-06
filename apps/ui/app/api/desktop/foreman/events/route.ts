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
        let close: (() => void) | undefined, timer: ReturnType<typeof setInterval> | undefined
        const stop = () => { close?.(); if (timer) clearInterval(timer) }
        const stream = new ReadableStream({
            async start(controller) {
                const emit = (value: string) => { try { controller.enqueue(encoder.encode(value)) } catch { stop() } }
                close = await app.subscribe(parsed.data, request.signal, event => emit(`data: ${JSON.stringify(event)}\n\n`))
                emit(': connected\n\n')
                timer = setInterval(() => emit(': keepalive\n\n'), 15_000)
                request.signal.addEventListener('abort', () => { stop(); try { controller.close() } catch {} }, { once: true })
                if (request.signal.aborted) { stop(); controller.close() }
            }, cancel() { stop() },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-store', connection: 'keep-alive' } })
    })
}
