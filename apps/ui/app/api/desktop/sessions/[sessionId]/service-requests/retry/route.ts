import { desktopServiceRequestMutationSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopServiceRequestScope } from '@/lib/desktop/server/service-requests/route-context'
import { DesktopServiceRetryRejected, acknowledgeDesktopServiceRetry, readDesktopServiceRetry, reserveDesktopServiceRetry, withDesktopServiceRequestAttempt } from '@/lib/desktop/server/service-requests/retry'

export const dynamic = 'force-dynamic'
type Params = { params: Promise<{ sessionId: string }> }

export function GET(request: Request, { params }: Params) {
    return desktopRoute(request, async runtime => {
        const serviceRequestId = new URL(request.url).searchParams.get('serviceRequestId') ?? ''
        if (!/^[a-f0-9]{64}$/.test(serviceRequestId)) throw new DesktopHttpError(400, 'Choose a valid app request.')
        const bound = await desktopServiceRequestScope(runtime, (await params).sessionId)
        return Response.json({ attempt: await readDesktopServiceRetry(bound.db, bound.scope, serviceRequestId) }, { headers: { 'cache-control': 'no-store' } })
    })
}

async function write(request: Request, { params }: Params, acknowledge: boolean) {
    return desktopRoute(request, async runtime => {
        const raw = await request.text()
        if (new TextEncoder().encode(raw).length > 32_768) throw new DesktopHttpError(413, 'App decisions exceed the saved retry limit.')
        let value: unknown
        try { value = JSON.parse(raw) } catch { throw new DesktopHttpError(400, 'Choose valid app decisions.') }
        const parsed = desktopServiceRequestMutationSchema.safeParse(value)
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose valid app decisions.')
        const bound = await desktopServiceRequestScope(runtime, (await params).sessionId)
        return withDesktopServiceRequestAttempt(bound.scope, async () => {
            if (acknowledge) {
                await acknowledgeDesktopServiceRetry(bound.db, bound.scope, parsed.data)
                return Response.json({ attempt: null }, { headers: { 'cache-control': 'no-store' } })
            }
            try {
                const attempt = await reserveDesktopServiceRetry(bound.db, bound.scope, parsed.data)
                return Response.json({ attempt }, { headers: { 'cache-control': 'no-store' } })
            } catch(error) {
                if(error instanceof DesktopServiceRetryRejected) return Response.json({error:error.message},{status:409,headers:{'x-service-request-outcome':'refused','x-service-request-attempt-id':parsed.data.requestId,'x-service-request-id':parsed.data.serviceRequestId}})
                throw error
            }
        })
    })
}

export const PUT = (request: Request, context: Params) => write(request, context, false)
export const DELETE = (request: Request, context: Params) => write(request, context, true)
