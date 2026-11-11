import type { DesktopRuntime } from '../runtime'
import { DesktopHttpError } from '../auth'
import { desktopRoute } from '../http'
import { readDesktopJson } from '../request-json'
import { alternateInputSchema, type createForemanAlternateRepository } from './repository'
export function createForemanAlternateHandler(resolve: (runtime: DesktopRuntime, signal: AbortSignal) => Promise<ReturnType<typeof createForemanAlternateRepository>>) {
    return (request: Request) => desktopRoute(request, async runtime => {
        if (request.method !== 'POST') throw new DesktopHttpError(405, 'Method not allowed')
        const parsed = alternateInputSchema.safeParse(await readDesktopJson(request, 4096))
        if (!parsed.success) throw new DesktopHttpError(400, 'Invalid alternate request.')
        if (parsed.data.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(409, 'This workspace changed.')
        const receipt = await (await resolve(runtime, request.signal)).request(parsed.data)
        // Preparation reserves storage, not an admitted model run. Keep the internal proof private.
        return Response.json({ requestId: receipt.input.requestId, status: receipt.state === 'ready' ? 'prepared' : 'uncertain' },
            { headers: { 'cache-control': 'no-store' } })
    })
}
