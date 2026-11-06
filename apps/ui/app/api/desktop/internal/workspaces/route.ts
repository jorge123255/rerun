import { z } from 'zod'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { beginDesktopWorkspaceAdmission, completeDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'
export const runtime = 'nodejs'
const bodySchema = z.strictObject({ action: z.enum(['freeze','unfreeze']), launchNonce: z.string(), expectedWorkspaceId: z.number().int().positive(), requestId: z.uuid(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
const replySchema = z.object({ ok: z.literal(true), frozen: z.boolean(), launchNonce: z.string(), workspaceId: z.number().int().positive(), sequence: z.number().int().positive() })
export async function POST(request: Request) {
    try {
        const ctx = await authenticateDesktopEngineRequest(request), body = bodySchema.parse(await readDesktopJson(request, 8192))
        if (body.launchNonce !== ctx.launchNonce || body.expectedWorkspaceId !== ctx.workspaceId) throw new DesktopHttpError(409, 'Workspace changed')
        beginDesktopWorkspaceAdmission(ctx, body.action, body.sequence)
        const reply = await fetch(`${ctx.engine.origin}/desktop/workspace-admission`, { method: 'POST', redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]), headers: { authorization: `Bearer ${ctx.engine.apiKey}`, 'content-type':'application/json' }, body: JSON.stringify({ action: body.action, launchNonce: ctx.launchNonce, workspaceId: ctx.workspaceId, sequence: body.sequence }) })
        if (!reply.ok) throw new DesktopHttpError(503, 'Workspace admission could not be confirmed')
        const saved = replySchema.safeParse(await reply.json())
        if (!saved.success || saved.data.launchNonce !== ctx.launchNonce || saved.data.workspaceId !== ctx.workspaceId || saved.data.sequence !== body.sequence || saved.data.frozen !== (body.action === 'freeze')) throw new DesktopHttpError(503, 'Workspace admission acknowledgement changed')
        completeDesktopWorkspaceAdmission(ctx, body.action, body.sequence)
        return Response.json({ ...saved.data, requestId: body.requestId })
    } catch (e) { return Response.json({ error: e instanceof DesktopHttpError ? e.message : 'Workspace transition could not be confirmed' }, { status: e instanceof DesktopHttpError ? e.status : 409 }) }
}
