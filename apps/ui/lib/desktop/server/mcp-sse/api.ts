import 'server-only'
import { z } from 'zod'
import { desktopMcpSseRequestSchema, desktopMcpSseRefSchema } from '@rerun/contracts'
import { authenticateDesktopRequest, DesktopHttpError } from '../auth'
import { getDesktopRemoteMcpService } from '../mcp-binding'
import { openDesktopDatabase } from '../database'
import { boundedText } from '../mcp/remote'
import { sseSettingsMutationSchema } from './settings'

const text = z.string().min(1).max(1024)
const inputSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('control'), input: desktopMcpSseRequestSchema }).strict(),
    z.object({ action: z.literal('mutate'), input: sseSettingsMutationSchema }).strict(),
    z.object({ action: z.literal('reconcile'), requestId: z.string().uuid() }).strict(),
    z.object({ action: z.literal('journal-read'), slot: text }).strict(),
    z.object({ action: z.literal('journal-put'), slot: text, input: sseSettingsMutationSchema }).strict(),
    z.object({ action: z.literal('journal-clear'), slot: text, requestId: z.string().uuid() }).strict(),
])

export async function handleDesktopSse(request: Request, agentId: string) {
    const headers = { 'Cache-Control': 'no-store' }
    try {
        const runtime = await authenticateDesktopRequest(request)
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(130_000)])
        const service = await getDesktopRemoteMcpService(runtime)
        await service.access(agentId)
        if (request.method !== 'POST') throw new DesktopHttpError(405, 'Method not allowed')
        const body = inputSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 16_384)))
        if ('input' in body && body.input.agentId !== agentId) throw new DesktopHttpError(409, 'Coworker changed')
        let result: unknown
        if (body.action === 'control') result = await service.sse.control(body.input, signal)
        else if (body.action === 'mutate') result = await service.sse.settings.mutate(body.input, signal)
        else if (body.action === 'reconcile') result = await service.sse.settings.reconcile(agentId, body.requestId, signal)
        else {
            const slot = z.tuple([z.literal('mcp-sse-editor'), z.literal(agentId), z.string().min(1).max(200)]).parse(JSON.parse(body.slot))
            const db = await openDesktopDatabase(runtime.dataRoot)
            if (body.action === 'journal-put') {
                const serverId = body.input.kind === 'save' ? body.input.serverId ?? 'new' : desktopMcpSseRefSchema.parse(body.input.reference).serverId
                if (serverId !== slot[2]) throw new DesktopHttpError(409, 'Editor changed')
                const encoded = JSON.stringify(body.input)
                await db.execute({ sql: 'INSERT INTO desktop_mcp_sse_editors(owner,slot,request_id,attempt) VALUES(?,?,?,?) ON CONFLICT DO NOTHING', args: [agentId, body.slot, body.input.requestId, encoded] })
                const current = (await db.execute({ sql: 'SELECT attempt FROM desktop_mcp_sse_editors WHERE owner=? AND slot=?', args: [agentId, body.slot] })).rows[0]
                if (current?.attempt !== encoded) throw new DesktopHttpError(409, 'An earlier editor attempt needs reconciliation')
                result = { saved: true }
            } else if (body.action === 'journal-clear') {
                await db.execute({ sql: 'DELETE FROM desktop_mcp_sse_editors WHERE owner=? AND slot=? AND request_id=?', args: [agentId, body.slot, body.requestId] })
                result = { cleared: true }
            } else {
                const row = (await db.execute({ sql: 'SELECT attempt FROM desktop_mcp_sse_editors WHERE owner=? AND slot=?', args: [agentId, body.slot] })).rows[0]
                result = row ? sseSettingsMutationSchema.parse(JSON.parse(String(row.attempt))) : null
            }
            await service.access(agentId); signal.throwIfAborted()
        }
        return Response.json(result, { headers })
    } catch (error) {
        return Response.json({ error: 'MCP request is unavailable or its acknowledgement is unknown. Refresh the saved state.' }, { status: error instanceof DesktopHttpError ? error.status : 400, headers })
    }
}
