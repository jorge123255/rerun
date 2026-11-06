import 'server-only'
import { z } from 'zod'
import { desktopRoute } from '../http'
import { DesktopHttpError } from '../auth'
import { readDesktopTriggerBody } from '../triggers/api'
import type { DesktopRuntime } from '../runtime'
import { triggerRequestDecisionSchema } from '../../trigger-requests/types'
import type { DesktopTriggerRequests } from './runtime'

const keySchema = z.string().regex(/^[a-f0-9]{64}$/)
const mutation = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('decide'), key: keySchema, decision: triggerRequestDecisionSchema }),
    z.strictObject({ action: z.literal('reconcile'), key: keySchema }),
    z.strictObject({ action: z.literal('stop'), key: keySchema }),
])
export function createTriggerRequestsApi(open: (runtime: DesktopRuntime) => Promise<DesktopTriggerRequests>) {
    return {
        GET: (request: Request, sessionId: string) => desktopRoute(request, async runtime => {
            const key = keySchema.parse(new URL(request.url).searchParams.get('key')), service = await open(runtime)
            const saved = await service.journal.get(key)
            if (!saved || saved.link.sessionId !== sessionId) throw new DesktopHttpError(404, 'Webhook request not found')
            const view = await service.lifecycle.read(saved.link)
            return Response.json({ request: view }, { headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
        }),
        POST: (request: Request, sessionId: string) => desktopRoute(request, async runtime => {
            const input = mutation.parse(await readDesktopTriggerBody(request, 131072)), service = await open(runtime)
            const saved = await service.journal.get(input.key)
            if (!saved || saved.link.sessionId !== sessionId) throw new DesktopHttpError(404, 'Webhook request not found')
            if (input.action === 'decide') return service.lifecycle.decide(input.key, input.decision)
            if (input.action === 'stop') await service.lifecycle.stop(input.key)
            else await service.lifecycle.reconcile(input.key)
            return Response.json({ request: await service.lifecycle.read(saved.link) }, { headers: { 'cache-control': 'no-store' } })
        }),
    }
}
