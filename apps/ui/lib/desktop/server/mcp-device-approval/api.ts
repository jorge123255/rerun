import 'server-only'
import { z } from 'zod'
import { desktopMcpSignInSourceSchema } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { authenticateDesktopRequest, DesktopHttpError } from '../auth'
import { boundedText } from '../mcp/remote'
import type { DesktopRuntime } from '../runtime'
import { deviceReviewDecisionSchema } from './model'
import type { bindTrustedMcpDeviceMethodReview } from './binding'

const requestSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('review-device-method'), source: desktopMcpSignInSourceSchema }).strict(),
    z.object({ action: z.literal('decide-device-method'), source: desktopMcpSignInSourceSchema, decision: deviceReviewDecisionSchema }).strict(),
    z.object({ action: z.literal('read-device-authorization'), source: desktopMcpSignInSourceSchema, reviewId: z.uuid(), revision: z.uuid() }).strict(),
    z.object({ action: z.enum(['start-device-authorization', 'check-device-authorization']), source: desktopMcpSignInSourceSchema, reviewId: z.uuid(), revision: z.uuid(), requestId: z.uuid() }).strict(),
])

/** Root mounts on the existing human session route after reviewing the broker adapter. */
export function createDesktopMcpDeviceReviewApi(resolve: (runtime: DesktopRuntime) => Promise<ReturnType<typeof bindTrustedMcpDeviceMethodReview>>) {
    return async (request: Request, sessionId: string) => {
        const headers = { 'Cache-Control': 'no-store' }
        if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers })
        try {
            const runtime = await authenticateDesktopRequest(request)
            const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
            const input = requestSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 40_960)))
            if (input.source.sessionId !== sessionId) throw new DesktopHttpError(409, 'Conversation changed')
            const service = await resolve(runtime)
            signal.throwIfAborted()
            if (input.action === 'read-device-authorization') {
                const authorization = await service.readAuthorization(input.source, input.reviewId, input.revision, signal)
                signal.throwIfAborted()
                return Response.json({ authorization }, { headers })
            }
            if (input.action === 'start-device-authorization' || input.action === 'check-device-authorization') {
                const attempt = await service.operate(input.source, input.reviewId, input.revision, input.requestId,
                    input.action === 'start-device-authorization' ? 'start' : 'complete', signal)
                signal.throwIfAborted()
                return Response.json({ attempt }, { headers })
            }
            const review = input.action === 'decide-device-method' ? await service.decide(input.source, input.decision, signal) : await service.review(input.source, signal)
            signal.throwIfAborted()
            return Response.json({ review }, { headers })
        } catch (error) {
            return Response.json({ error: 'Device method review unavailable or changed. Reload this conversation.' }, { status: error instanceof DesktopHttpError ? error.status : 409, headers })
        }
    }
}
