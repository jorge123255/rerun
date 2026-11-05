import 'server-only'
import { desktopSecretRequestDecisionSchema, desktopSecretRequestResponseSchema, type DesktopSecretRequestDecision, type DesktopSecretRequestView } from '../../../../../../packages/contracts/src/desktop-secret-requests'
import { DesktopHttpError } from '../auth'

export const DESKTOP_SECRET_REQUEST_BODY_MAX_BYTES = 100_000

export type DesktopSecretRequestApiPorts = {
    read: (sessionId: string, signal: AbortSignal) => Promise<DesktopSecretRequestView | null>
    decide: (sessionId: string, input: DesktopSecretRequestDecision, signal: AbortSignal) => Promise<Response>
}

async function body(request: Request): Promise<unknown> {
    const length = Number(request.headers.get('content-length') ?? 0)
    if (length > DESKTOP_SECRET_REQUEST_BODY_MAX_BYTES) throw new DesktopHttpError(413, 'Credential submission is too large.')
    const text = await request.text()
    if (Buffer.byteLength(text, 'utf8') > DESKTOP_SECRET_REQUEST_BODY_MAX_BYTES) throw new DesktopHttpError(413, 'Credential submission is too large.')
    try { return JSON.parse(text) } catch { throw new DesktopHttpError(400, 'Credential submission must be JSON.') }
}

function decision(value: unknown): DesktopSecretRequestDecision {
    const parsed = desktopSecretRequestDecisionSchema.safeParse(value)
    if (!parsed.success) throw new DesktopHttpError(400, 'Credential submission is invalid.')
    return parsed.data
}

export function createDesktopSecretRequestApi(ports: DesktopSecretRequestApiPorts) {
    return {
        async GET(request: Request, sessionId: string): Promise<Response> {
            const view = await ports.read(sessionId, requestSignal(request))
            return Response.json(desktopSecretRequestResponseSchema.parse({ request: view }), { headers: { 'Cache-Control': 'no-store' } })
        },
        async POST(request: Request, sessionId: string): Promise<Response> {
            const input = decision(await body(request))
            if (input.source.sessionId !== sessionId) throw new DesktopHttpError(409, 'This credential request belongs to another conversation.')
            const response = await ports.decide(sessionId, input, requestSignal(request))
            if (response.headers.get('x-secret-request-id') !== input.requestId || !response.headers.get('x-run-id')) throw new DesktopHttpError(502, 'Credential decision acknowledgement belonged to another request.')
            response.headers.set('Cache-Control', 'no-store')
            return response
        },
    }
}

function requestSignal(request: Request): AbortSignal {
    return AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
}
