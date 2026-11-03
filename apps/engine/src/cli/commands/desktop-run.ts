import type { Server } from 'node:http'
import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { z } from 'zod'
import { createServer } from '../../http/server.js'
import { prepareDataDir } from '../../datadir/ladder.js'
import { reconcileInterruptedRuns } from '../../runtime/reconcile.js'
import { abortAllRuns } from '../../runtime/run-control.js'
import { closeAllMcp } from '../../tools/mcp-pool.js'
import { env } from '../../config/env.js'
import { desktopApp, desktopRouteAllowed } from '../../desktop/policy.js'

const secret = z.string().regex(/^[a-f0-9]{64}$/)
const origin = z.string().url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && url.origin === value
})
const runtimeSchema = z.object({
    protocolVersion: z.literal(1), launchNonce: z.string().uuid(), buildId: z.string().min(1), workspaceId: z.literal(1),
    dataRoot: z.string(), app: z.object({ origin, sessionToken: secret }), engine: z.object({ origin, apiKey: secret }),
})

export async function desktopRunCommand(): Promise<void> {
    if (!desktopApp() || !process.send || !process.env.RERUN_DESKTOP_RUNTIME_FILE) throw new Error('Desktop engine requires an app-managed launch')
    const runtime = runtimeSchema.parse(JSON.parse(await readFile(process.env.RERUN_DESKTOP_RUNTIME_FILE, 'utf8')))
    const config = env()
    if (config.RERUN_HOST !== '127.0.0.1' || Number(new URL(runtime.engine.origin).port) !== config.RERUN_PORT || config.RERUN_HUB_BASE_URL !== runtime.app.origin) throw new Error('Desktop engine address mismatch')
    if (!config.RERUN_API_KEY || config.RERUN_API_KEY.length !== 64 || !timingSafeEqual(Buffer.from(config.RERUN_API_KEY), Buffer.from(runtime.engine.apiKey))) throw new Error('Desktop engine credential mismatch')
    if (!secret.safeParse(process.env.RERUN_DESKTOP_SECRET_KEY).success) throw new Error('Desktop credential encryption is unavailable')
    if (await realpath(config.RERUN_DATA_DIR) !== await realpath(resolve(runtime.dataRoot, 'workspaces', '1', 'engine'))) throw new Error('Desktop engine data root mismatch')
    await prepareDataDir()
    await reconcileInterruptedRuns()
    let stopping = false
    const app = new Hono()
    app.use('*', async (c, next) => {
        const expected = `Bearer ${runtime.engine.apiKey}`
        const supplied = c.req.header('authorization') ?? ''
        if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return c.json({ error: 'Unauthorized' }, 401)
        if (c.req.header('host') !== new URL(runtime.engine.origin).host || (c.req.header('origin') && c.req.header('origin') !== runtime.app.origin)) return c.json({ error: 'Forbidden' }, 403)
        if (stopping) return c.json({ error: 'Engine is stopping' }, 503)
        if (!desktopRouteAllowed(c.req.method, c.req.path)) return c.json({ error: 'This feature is not enabled in the desktop preview' }, 403)
        return next()
    })
    const ready = { status: 'ready', protocolVersion: 1, launchNonce: runtime.launchNonce, buildId: runtime.buildId, workspaceId: 1 }
    app.get('/health', c => c.json(ready))
    app.route('/', createServer())
    let server: Server
    const shutdown = async () => {
        if (stopping) return
        stopping = true
        const closed = new Promise<void>(done => server.close(() => done()))
        await abortAllRuns()
        await closeAllMcp()
        server.closeAllConnections()
        await closed
        process.send?.({ type: 'stopped', launchNonce: runtime.launchNonce })
        process.exit(0)
    }
    server = serve({ fetch: app.fetch, port: config.RERUN_PORT, hostname: '127.0.0.1' }, () => {
        process.send?.({ type: 'ready', ...ready })
    }) as Server
    process.on('message', message => { if ((message as { type?: string })?.type === 'stop') void shutdown() })
    process.once('disconnect', () => { void shutdown() })
    process.once('SIGTERM', () => { void shutdown() })
    process.once('SIGINT', () => { void shutdown() })
}
