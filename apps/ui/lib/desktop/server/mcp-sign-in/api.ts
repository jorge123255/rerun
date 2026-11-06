import 'server-only'
import { z } from 'zod'
import { desktopMcpSignInDecisionSchema, desktopMcpSignInResponseSchema, type DesktopMcpSignInDecision } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { DesktopHttpError } from '../auth'
import type { DesktopMcpSignInRuntimeApi } from './runtime'

const actionSchema = z.object({ action: z.enum(['connect', 'status', 'complete', 'decline', 'cancel', 'recover']), request: desktopMcpSignInDecisionSchema }).strict()

async function input(request: Request): Promise<{ action: 'connect' | 'status' | 'complete' | 'decline' | 'cancel' | 'recover'; request: DesktopMcpSignInDecision }> {
    const text = await request.text()
    if (Buffer.byteLength(text, 'utf8') > 65_536) throw new DesktopHttpError(413, 'MCP sign-in decision is too large.')
    const parsed = actionSchema.safeParse(JSON.parse(text))
    if (!parsed.success) throw new DesktopHttpError(400, 'MCP sign-in decision is invalid.')
    return parsed.data
}

export function createDesktopMcpSignInApi(ports: DesktopMcpSignInRuntimeApi) {
    const signal = (request: Request) => AbortSignal.any([request.signal, AbortSignal.timeout(35_000)])
    return {
        async GET(request: Request, sessionId: string): Promise<Response> {
            return Response.json(desktopMcpSignInResponseSchema.parse(await ports.read(sessionId, signal(request))), { headers: { 'Cache-Control': 'no-store' } })
        },
        async POST(request: Request, sessionId: string): Promise<Response> {
            const body = await input(request)
            if (body.request.source.sessionId !== sessionId) throw new DesktopHttpError(409, 'This MCP sign-in belongs to another conversation.')
            if (body.action === 'complete' || body.action === 'decline' || body.action === 'recover') {
                const response = await (body.action === 'complete' ? ports.complete(body.request, signal(request)) : body.action === 'decline' ? ports.decline(body.request, signal(request)) : ports.recover(body.request, signal(request)))
                if (response.headers.get('x-mcp-sign-in-request-id') !== body.request.requestId || response.headers.get('x-session-id') !== sessionId || !response.headers.get('x-run-id')) {
                    throw new DesktopHttpError(502, 'MCP sign-in acknowledgement belonged to another request.')
                }
                response.headers.set('Cache-Control', 'no-store')
                return response
            }
            const result = body.action === 'connect' ? await ports.connect(body.request, signal(request)) : body.action === 'status' ? await ports.status(body.request, signal(request)) : await ports.cancel(body.request, signal(request))
            return Response.json(desktopMcpSignInResponseSchema.parse(result), { headers: { 'Cache-Control': 'no-store' } })
        },
    }
}
