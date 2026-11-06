import { interceptDesktopWebhookDecision } from '@/lib/desktop/server/trigger-requests/binding'
import { desktopServiceRequestMutationSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopServiceRequestPorts, desktopServiceRequestScope } from '@/lib/desktop/server/service-requests/route-context'
import { rejectDesktopServiceRetry, reserveDesktopServiceRetry, withDesktopServiceRequestAttempt } from '@/lib/desktop/server/service-requests/retry'
import { finishDesktopServiceRequest, progressDesktopServiceRequest, readDesktopServiceRequest } from '@/lib/desktop/server/service-requests/service'

export const dynamic = 'force-dynamic'
type Params = { params: Promise<{ sessionId: string }> }

export async function GET(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        const bound = await desktopServiceRequestScope(runtime, (await params).sessionId)
        return Response.json(await readDesktopServiceRequest(bound.db, bound.scope, desktopServiceRequestPorts(runtime, bound, signal)), { headers: { 'cache-control': 'no-store' } })
    })
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(130_000)])
        const raw = await request.text()
        if (new TextEncoder().encode(raw).length > 32_768) throw new DesktopHttpError(413, 'App decisions exceed the saved retry limit.')
        let value: unknown
        try { value = JSON.parse(raw) } catch { throw new DesktopHttpError(400, 'Choose valid app decisions.') }
        const parsed = desktopServiceRequestMutationSchema.safeParse(value)
        if (!parsed.success) throw new DesktopHttpError(400, 'Save each app as pending, skip, or a current connection, then finish only those saved choices.')
        const input = parsed.data
        const bound = await desktopServiceRequestScope(runtime, (await params).sessionId)
        const ports = desktopServiceRequestPorts(runtime, bound, signal)
        return withDesktopServiceRequestAttempt(bound.scope, async () => {
            try {
                signal.throwIfAborted()
                await reserveDesktopServiceRetry(bound.db, bound.scope, input)
                const response = input.action === 'progress'
                    ? Response.json(await progressDesktopServiceRequest(bound.db, bound.scope, ports, input), { headers: { 'cache-control': 'no-store' } })
                    : await interceptDesktopWebhookDecision(runtime, (await params).sessionId, { kind: 'service', input }) ?? await finishDesktopServiceRequest(bound.db, bound.scope, ports, input)
                response.headers.set('x-service-request-attempt-id', input.requestId)
                return response
            } catch (error) {
                if (error instanceof DesktopHttpError && error.status >= 400 && error.status < 500
                    && await rejectDesktopServiceRetry(bound.db, bound.scope, input)) {
                    return Response.json({ error: error.message }, { status: error.status, headers: {
                        'cache-control': 'no-store', 'x-service-request-outcome': 'refused',
                        'x-service-request-attempt-id': input.requestId, 'x-service-request-id': input.serviceRequestId,
                    } })
                }
                throw error
            }
        })
    })
}
