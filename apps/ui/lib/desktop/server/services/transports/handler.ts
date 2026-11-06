import 'server-only'
import { z } from 'zod'
import { authenticateDesktopRequest, DesktopHttpError } from '../../auth'
import { getDesktopRemoteMcpService } from '../../mcp-binding'
import { boundedText } from '../../mcp/remote'
import { serviceTransportControlSchema, serviceTransportRefSchema } from '@rerun/contracts'
import { serviceTransportApi } from './api'
const requestSchema = z.discriminatedUnion('action', [
    z.object({ action: z.enum(['control', 'reconcile']), request: serviceTransportControlSchema }).strict(),
    z.object({ action: z.literal('pending'), ref: serviceTransportRefSchema }).strict(),
    z.object({ action: z.enum(['reserve', 'clear']), request: serviceTransportControlSchema }).strict(),
])
export async function handleDesktopServiceTransports(request: Request, owner: string): Promise<Response> {
    try {
        const runtime = await authenticateDesktopRequest(request)
        if (request.method !== 'POST') throw new DesktopHttpError(405, 'Method not allowed.')
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(125_000)])
        const body = requestSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 8192)))
        const ref = body.action === 'pending' ? body.ref : body.request
        if (ref.agentId !== owner) throw new DesktopHttpError(409, 'Account owner changed.')
        const { serviceTransports } = await getDesktopRemoteMcpService(runtime)
        if (body.action === 'control' || body.action === 'reconcile') {
            const api = serviceTransportApi(serviceTransports.runtime)
            return Response.json(await api[body.action](body.request, owner, signal), { headers: { 'cache-control': 'no-store' } })
        }
        const authority = await serviceTransports.authorize(ref, 'read', undefined, signal)
        let pending = null
        if (body.action === 'pending') pending = await serviceTransports.pending.read(ref)
        else if (body.action === 'reserve') await serviceTransports.pending.put(body.request)
        else await serviceTransports.pending.clear(body.request)
        authority.check(); signal.throwIfAborted()
        return Response.json({ pending }, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
        return Response.json({ error: 'Connection acknowledgement unavailable. Refresh this account and reconcile before retrying.' }, { status: error instanceof DesktopHttpError ? error.status : 409, headers: { 'cache-control': 'no-store' } })
    }
}
