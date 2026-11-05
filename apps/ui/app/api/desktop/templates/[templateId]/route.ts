import { desktopTemplateDetailSchema, desktopTemplateIdSchema, desktopTemplateOperationSchema, desktopTemplateRevisionSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { request } from '@/lib/engine/client'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { engineOf } from '@/lib/desktop/server/settings'
import { desktopTemplateAuthority } from '@/lib/desktop/server/templates/authority'
import { openDesktopTemplateServer } from '@/lib/desktop/server/templates/server'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ templateId: string }> }

async function serverFor(runtime: DesktopRuntime) {
    const engine = engineOf(runtime)
    return openDesktopTemplateServer(await openDesktopDatabase(runtime.dataRoot), {
        post: (path, body, signal) => request(engine, path, { method: 'POST', body: JSON.stringify(body), signal, cache: 'no-store' }, data => data),
        get: (path, signal) => request(engine, path, { method: 'GET', signal, cache: 'no-store' }, data => data),
    }, desktopTemplateAuthority())
}

export function GET(request: Request, context: Context) {
    return desktopRoute(request, async runtime => {
        const { templateId } = await context.params
        if (!desktopTemplateIdSchema.safeParse(templateId).success) throw new DesktopHttpError(400, 'Invalid template')
        const revision = new URL(request.url).searchParams.get('revision') ?? undefined
        if (revision && !desktopTemplateRevisionSchema.safeParse(revision).success) throw new DesktopHttpError(400, 'Invalid template revision')
        const server = await serverFor(runtime)
        const detail = desktopTemplateDetailSchema.parse(await server.handle({ operation: 'detail', templateId, ...(revision ? { revision } : {}) }))
        return Response.json(detail, { headers: { 'cache-control': 'no-store' } })
    })
}

export function POST(request: Request, context: Context) {
    return desktopRoute(request, async runtime => {
        const { templateId } = await context.params
        const parsed = desktopTemplateOperationSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success || !('templateId' in parsed.data) || parsed.data.templateId !== templateId) {
            throw new DesktopHttpError(400, 'Invalid template request')
        }
        const server = await serverFor(runtime)
        return Response.json(await server.handle(parsed.data), { headers: { 'cache-control': 'no-store' } })
    })
}
