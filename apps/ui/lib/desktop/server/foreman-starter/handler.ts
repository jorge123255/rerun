import type { DesktopRuntime } from '../runtime'
import { DesktopHttpError } from '../auth'
import { desktopRoute } from '../http'
import { boundedText } from '../mcp/remote'
import { starterDecisionSchema, starterScopeSchema, type createForemanStarterRepository } from './repository'
type Repository = ReturnType<typeof createForemanStarterRepository>
/** Root supplies a workspace-authenticated repository. No route is mounted by this module. */
export function createForemanStarterHandler(resolve: (runtime: DesktopRuntime) => Promise<Repository>) {
    return (request: Request) => desktopRoute(request, async runtime => {
        if (request.method === 'GET') {
            const url = new URL(request.url)
            const scope = starterScopeSchema.safeParse({ workspaceId: url.searchParams.get('workspaceId'), chatId: url.searchParams.get('chatId') })
            if (!scope.success || scope.data.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(409, 'This workspace changed.')
            const repository = await resolve(runtime), requestId = url.searchParams.get('requestId')
            return Response.json(requestId ? { receipt: await repository.receipt(scope.data, requestId) } : { pending: await repository.pending(scope.data) }, { headers: { 'cache-control': 'no-store' } })
        }
        if (request.method !== 'POST') throw new DesktopHttpError(405, 'Method not allowed')
        const parsed = starterDecisionSchema.safeParse(JSON.parse(await boundedText(new Response(request.body), request.signal, 24000)))
        if (!parsed.success) throw new DesktopHttpError(400, 'Invalid starter decision.')
        if (parsed.data.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(409, 'This workspace changed.')
        const receipt = await (await resolve(runtime)).decide(parsed.data)
        return Response.json({ receipt }, { headers: { 'cache-control': 'no-store' } })
    })
}
