import 'server-only'
import { z } from 'zod'
import { DESKTOP_FOREMAN_DOCS_LIMITS, desktopForemanDocsInternalRequestSchema } from '@rerun/contracts'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'
import { readDesktopJson } from '../request-json'
import { desktopForemanDocs } from './binding'
import { DesktopForemanDocsLiveError } from './service'

export async function handleDesktopForemanDocs(request: Request): Promise<Response> {
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        const input = desktopForemanDocsInternalRequestSchema.parse(await readDesktopJson(request, DESKTOP_FOREMAN_DOCS_LIMITS.maxRequestBytes))
        if (input.launchNonce !== runtime.launchNonce) throw new DesktopHttpError(409, 'Foreman launch changed.')
        const service = await desktopForemanDocs(runtime)
        const result = await service.search({ binding: input.binding, toolCallId: input.toolCallId, query: input.query, corpus: input.corpus }, request.signal)
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
        const status = error instanceof DesktopHttpError ? error.status : error instanceof z.ZodError ? 400 : error instanceof DesktopForemanDocsLiveError ? 409 : 409
        return Response.json({ error: 'The documentation search could not be completed. Reconcile this request before retrying.' }, { status, headers: { 'cache-control': 'no-store' } })
    }
}
