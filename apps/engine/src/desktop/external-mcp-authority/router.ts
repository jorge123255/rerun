import { Hono } from 'hono'
import { externalMcpCreateResultSchema, externalMcpListResultSchema, externalMcpListenerResultSchema, externalMcpRevokeResultSchema, externalMcpWorkspaceIdSchema } from '@rerun/contracts'
import { desktopApp } from '../policy.js'
import type { createExternalMcpService } from './service.js'

type Service = ReturnType<typeof createExternalMcpService>

function statusFor(code: string): 400 | 401 | 403 | 404 | 409 | 503 {
    if (code === 'unauthorized' || code === 'expired' || code === 'revoked') return 401
    if (code === 'forbidden_origin' || code === 'forbidden_host' || code === 'forbidden_url' || code === 'workspace_mismatch' || code === 'scope_missing' || code === 'scope_refused') return 403
    if (code === 'not_found') return 404
    if (code === 'replay_conflict' || code === 'in_flight') return 409
    if (code === 'authority_missing' || code === 'runtime_stopped' || code === 'listener_disabled' || code === 'adapter_missing' || code === 'uncertain') return 503
    return 400
}

async function body(request: Request): Promise<unknown> {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw Object.assign(new Error('Use application/json.'), { status: 415 })
    const text = await request.text()
    if (text.length > 1_000_000) throw Object.assign(new Error('External MCP request is too large.'), { status: 413 })
    return text ? JSON.parse(text) : null
}

/** Management routes for the desktop app. Root mounts this behind the existing engine credential. It is not the external listener. */
export function createDesktopExternalMcpRouter(getService: () => Service) {
    const app = new Hono()
    app.use('*', async (c, next) => {
        if (!desktopApp()) return c.json({ ok: false, code: 'unsupported', message: 'Not found' }, 404)
        return next()
    })
    app.onError((error, c) => {
        const status = typeof (error as { status?: number }).status === 'number' ? (error as { status: number }).status : 400
        return c.json({ ok: false, code: 'invalid', message: error instanceof Error ? error.message : 'That external key request is not valid.' }, status as 400)
    })
    const send = (result: { ok: boolean; code?: string }) => {
        if (result.ok) return { body: result, status: 200 as const }
        return { body: result, status: statusFor(result.code ?? 'invalid') }
    }
    app.get('/keys', async c => {
        const workspaceId = externalMcpWorkspaceIdSchema.parse(Number(c.req.query('workspaceId')))
        const result = await getService().list(workspaceId)
        const parsed = externalMcpListResultSchema.safeParse(result)
        if (parsed.success) return c.json(parsed.data)
        const http = send(result as { ok: false; code: string })
        return c.json(http.body, http.status)
    })
    app.post('/keys', async c => {
        const result = externalMcpCreateResultSchema.parse(await getService().create(await body(c.req.raw)))
        const http = send(result)
        return c.json(http.body, http.status)
    })
    app.post('/keys/revoke', async c => {
        const result = externalMcpRevokeResultSchema.parse(await getService().revoke(await body(c.req.raw)))
        const http = send(result)
        return c.json(http.body, http.status)
    })
    app.get('/listener', async c => c.json(await getService().listener()))
    app.post('/listener/enable', async c => {
        const result = externalMcpListenerResultSchema.parse(await getService().enable(await body(c.req.raw)))
        const http = send(result)
        return c.json(http.body, http.status)
    })
    app.post('/listener/disable', async c => {
        const result = externalMcpListenerResultSchema.parse(await getService().disable(await body(c.req.raw)))
        const http = send(result)
        return c.json(http.body, http.status)
    })
    return app
}
