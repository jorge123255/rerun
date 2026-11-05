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
import { desktopCodexAction } from '@rerun/contracts'
import { codexLoginAction, codexLoginStatus, stopCodexLogin } from '../../desktop/codex-login.js'
import { desktopApp, desktopRouteAllowed } from '../../desktop/policy.js'
import { bindDesktopSchedules } from '../../desktop/schedule-binding.js'
import { startScheduler } from '../../runtime/scheduler.js'
import { stopDesktopSkillProposals } from '../../desktop/skill-proposal-work.js'
import { recoverNativeWritebackOutbox } from '../../desktop/native-writeback/outbox.js'
import { sendNativeWriteback } from '../../desktop/native-writeback/client.js'
import { stopAllDesktopNativeWorkers } from '../../desktop/native-worker.js'
import { initializeDesktopBrainStore } from '../../desktop/brain-pages-router.js'
import { stopDesktopMcp } from '../../desktop/mcp-tools.js'
import { logger } from '../../lib/logger.js'

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
    await initializeDesktopBrainStore()
    const lifetime = new AbortController()
    let schedules: Awaited<ReturnType<typeof bindDesktopSchedules>> | undefined
    let stopScheduler: ReturnType<typeof startScheduler> | undefined
    let stopping = false
    let shutdownActive = false
    let initialized = false
    const app = new Hono()
    app.use('*', async (c, next) => {
        const expected = `Bearer ${runtime.engine.apiKey}`
        const supplied = c.req.header('authorization') ?? ''
        if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return c.json({ error: 'Unauthorized' }, 401)
        if (c.req.header('host') !== new URL(runtime.engine.origin).host || (c.req.header('origin') && c.req.header('origin') !== runtime.app.origin)) return c.json({ error: 'Forbidden' }, 403)
        if (stopping) return c.json({ error: 'Engine is stopping' }, 503)
        // Reconciliation callbacks adopt sessions by reading this engine. Permit authenticated
        // reads while recovering, but no writes or new model runs until all bindings are ready.
        if (!initialized && c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.json({ error: 'Engine is starting' }, 503)
        if (!desktopRouteAllowed(c.req.method, c.req.path)) return c.json({ error: 'This feature is not enabled in the desktop preview' }, 403)
        return next()
    })
    const ready = { status: 'ready', protocolVersion: 1, launchNonce: runtime.launchNonce, buildId: runtime.buildId, workspaceId: 1 }
    app.get('/desktop/codex-login', async c => c.json(await codexLoginStatus()))
    app.post('/desktop/codex-login', async c => {
        const parsed = desktopCodexAction.safeParse((await c.req.json().catch(() => null))?.action)
        if (!parsed.success) return c.json({ error: 'Invalid sign-in action.' }, 400)
        return c.json(await codexLoginAction(parsed.data))
    })
    app.get('/health', c => initialized ? c.json(ready) : c.json({ status: 'starting' }, 503))
    app.route('/', createServer())
    let server: Server
    const shutdown = async () => {
        if (shutdownActive) return
        shutdownActive = true
        stopping = true
        lifetime.abort()
        stopScheduler?.()
        const closed = new Promise<void>(done => server.close(() => done()))
        stopCodexLogin()
        // Close admissions before waiting for any preparation. Callback delivery is best effort
        // during teardown; failure must never reopen either local service or prevent shutdown.
        const closing = Promise.allSettled([schedules?.close(), stopDesktopMcp(), stopDesktopSkillProposals()])
        // Preparing scheduled runs already register a controller in runAgent. Signal those
        // before draining preparation, otherwise a stuck provider can prevent its own Stop.
        await Promise.allSettled([closing, abortAllRuns(), stopScheduler?.drain()])
        // Schedule admission closes synchronously; its final UI notification is
        // best effort and owns no child process. Only tool drains require ACK.
        const shutdownFailures = (await closing).slice(1).filter(result => result.status === 'rejected').length
        const remaining = await Promise.allSettled([abortAllRuns(), closeAllMcp(), stopAllDesktopNativeWorkers()])
        server.closeAllConnections()
        await closed
        const failed = shutdownFailures + remaining.filter(result => result.status === 'rejected').length
        if (failed) logger.error({ count: failed }, 'Desktop process cleanup was not confirmed')
        process.send?.({ type: failed ? 'stop-failed' : 'stopped', launchNonce: runtime.launchNonce })
        // Keep process custody and admission closed after an uncertain drain.
        // A later stop request may retry; parent exit must not hide live writers.
        if (failed) { shutdownActive = false; return }
        process.exit(0)
    }
    server = serve({ fetch: app.fetch, port: config.RERUN_PORT, hostname: '127.0.0.1' }, () => {
        void (async () => {
            // The UI starts first. Reconcile after listening so its authenticated callbacks can
            // fetch the exact session and run before persisting a restart failure notification.
            await reconcileInterruptedRuns()
            if (stopping) return
            const recovered = await recoverNativeWritebackOutbox(bundle => sendNativeWriteback(bundle, lifetime.signal))
            if (recovered.retained.length) logger.warn({ count: recovered.retained.length }, 'Native file review captures retained for later recovery')
            if (stopping) return
            schedules = await bindDesktopSchedules(runtime)
            if (stopping) { await schedules.close().catch(() => {}); return }
            initialized = true
            stopScheduler = startScheduler()
            process.send?.({ type: 'ready', ...ready })
        })().catch(error => { logger.error({ err: String(error) }, 'desktop schedule startup failed'); void shutdown() })
    }) as Server
    process.on('message', message => { if ((message as { type?: string })?.type === 'stop') void shutdown() })
    process.once('disconnect', () => { void shutdown() })
    process.once('SIGTERM', () => { void shutdown() })
    process.once('SIGINT', () => { void shutdown() })
}
