import type { DesktopRuntime } from '../runtime'
import { DesktopHttpError } from '../auth'
import { desktopRoute } from '../http'
import { boundedText } from '../mcp/remote'
import { alternateInputSchema, type createForemanAlternateRepository } from './repository'
/** Unmounted until root supplies canonical reply/run proof AND Foreman-safe alternate engine authority. */
export function createForemanAlternateHandler(resolve: (runtime: DesktopRuntime) => Promise<ReturnType<typeof createForemanAlternateRepository>>) {
    return (request: Request) => desktopRoute(request, async runtime => {
        if (request.method !== 'POST') throw new DesktopHttpError(405, 'Method not allowed')
        const parsed = alternateInputSchema.safeParse(JSON.parse(await boundedText(new Response(request.body), request.signal, 4000)))
        if (!parsed.success) throw new DesktopHttpError(400, 'Invalid alternate request.')
        if (parsed.data.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(409, 'This workspace changed.')
        return Response.json(await (await resolve(runtime)).request(parsed.data), { headers: { 'cache-control': 'no-store' } })
    })
}
