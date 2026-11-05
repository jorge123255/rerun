import { desktopTemplateListSchema, desktopTemplateOperationSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { request } from '@/lib/engine/client'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { engineOf } from '@/lib/desktop/server/settings'
import { desktopTemplateAuthority } from '@/lib/desktop/server/templates/authority'
import { openDesktopTemplateServer } from '@/lib/desktop/server/templates/server'

export const dynamic = 'force-dynamic'

async function serverFor(runtime: DesktopRuntime) {
    const engine = engineOf(runtime)
    return openDesktopTemplateServer(await openDesktopDatabase(runtime.dataRoot), {
        post: (path, body, signal) => request(engine, path, { method: 'POST', body: JSON.stringify(body), signal, cache: 'no-store' }, data => data),
        get: (path, signal) => request(engine, path, { method: 'GET', signal, cache: 'no-store' }, data => data),
    }, desktopTemplateAuthority())
}

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const server = await serverFor(runtime)
        const templates = desktopTemplateListSchema.parse(await server.handle({ operation: 'list' }))
        return Response.json(templates, { headers: { 'cache-control': 'no-store' } })
    })
}

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopTemplateOperationSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Invalid template request')
        const server = await serverFor(runtime)
        const body = await server.handle(parsed.data)
        const status = parsed.data.operation === 'create-draft' ? 201 : 200
        return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
    })
}
