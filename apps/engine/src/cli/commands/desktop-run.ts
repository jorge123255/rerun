import { registerDesktopOpencodeConnection } from '../../desktop/opencode/registry.js'
import { createDesktopOpencodeConnectionStore } from '../../desktop/opencode/connection-store.js'
import { desktopOpencodeConnectionRoutes } from '../../desktop/opencode/connection-routes.js'
import { desktopOpencodeListedModels } from '../../desktop/opencode/catalog.js'
import { readBoxDefault } from '../../connections/default.js'
import { initializeDesktopCompanyBriefStore } from '../../desktop/company-brief/runtime.js'
import { bindDesktopComputerPanel } from '../../desktop/computer-panel/binding.js'
import { bindDesktopGuestShell } from '../../desktop/guest-shell/runtime.js'
import { bindDesktopClaudePlanAuth } from '../../desktop/claude-plan/auth.js'
import { stopDesktopClaudeWorkers } from '../../desktop/claude-plan/runtime.js'
import {
    desktopSubscriptionChatAvailable, desktopSubscriptionRunnerAvailable, drainDesktopSubscriptionTurns,
    readDesktopSubscriptionCatalog, refreshDesktopSubscriptionCatalog, stopDesktopSubscriptionRunners,
} from '../../desktop/subscription-acp/runtime.js'
import { bindDesktopSubscriptionDeviceLogin } from '../../desktop/subscription-acp/device-login.js'
import { createDesktopTriggerToolRuntime } from '../../desktop/trigger-tools/runtime.js'
import { ensureForeman } from '../../agents/foreman.js'
import { bindDesktopForeman } from '../../desktop/foreman/binding.js'
import { createPrivateDatabaseShareRoutes } from '../../desktop/coworker-share-database/routes.js'
import { createDesktopForemanRoutes } from '../../desktop/foreman/routes.js'
import { createDesktopScheduleToolRuntime } from '../../desktop/schedule-tools/runtime.js'
import { bindDesktopToolInstall } from '../../desktop/tool-install/binding.js'
import { bindDesktopDelegation, installDesktopDelegation } from '../../desktop/delegation/binding.js'
import { createDesktopTriggerRuntime, readDesktopTriggerRuntime } from '../../desktop/triggers/runtime.js'
import { createDesktopTriggerRoutes } from '../../desktop/triggers/router.js'
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
import { desktopCodexAction, desktopClaudePlanActionSchema, desktopCliUpdateActionSchema, desktopSubscriptionLoginAction } from '@rerun/contracts'
import { readDesktopProviderUsage } from '../../desktop/provider-usage/usage.js'
import { bindDesktopCliUpdates } from '../../desktop/cli-updates/updates.js'
import { keepDesktopPlanLimits } from '../../desktop/plan-limits-file.js'
import { codexLoginAction, codexLoginStatus, stopCodexLogin } from '../../desktop/codex-login.js'
import { desktopApp, desktopRouteAllowed } from '../../desktop/policy.js'
import { bindDesktopSchedules } from '../../desktop/schedule-binding.js'
import { startScheduler } from '../../runtime/scheduler.js'
import { stopDesktopSkillProposals } from '../../desktop/skill-proposal-work.js'
import { recoverNativeWritebackOutbox } from '../../desktop/native-writeback/outbox.js'
import { sendNativeWriteback } from '../../desktop/native-writeback/client.js'
import { stopAllDesktopNativeWorkers } from '../../desktop/native-worker.js'
import { bindDesktopCustomProviders } from '../../desktop/custom-providers/binding.js'
import { initializeDesktopBrainStore } from '../../desktop/brain-pages-router.js'
import { stopDesktopMcp } from '../../desktop/mcp-tools.js'
import { logger } from '../../lib/logger.js'
import { bindIsolatedScreen } from '../../desktop/isolated-screen/binding.js'
import { initializeComputerLaunchers } from '../../desktop/computer-launchers/sqlite-store.js'
import { shutdownDesktopSemanticMemory } from '../../desktop/semantic-memory/runtime.js'
import { reconcileIsolatedScreens, shutdownIsolatedScreens } from '../../desktop/isolated-screen/index.js'
import { bindDesktopCoworkerCalls } from '../../desktop/coworker-calls/bind.js'
import { createDesktopStopDiagnostic } from './desktop-stop-diagnostic.js'
import { bindExternalMcpRuntimeAuthority } from '../../desktop/external-mcp-authority/authority.js'
import { initializeDesktopExternalMcp, getExternalMcpService, closeDesktopExternalMcp } from '../../desktop/external-mcp-authority/runtime.js'
import { createDesktopExternalMcpRouter } from '../../desktop/external-mcp-authority/router.js'
import { registerExternalMcpDispatch } from '../../desktop/external-mcp-authority/dispatch.js'
import { createExternalMcpUiDispatch } from '../../desktop/external-mcp-tools/bridge.js'
import { bindSharedMutationWorkspace } from '../../desktop/shared-file-mutations/tools.js'
import { assertDesktopRunAdmission, observeDesktopAdmissionChange } from '../../desktop/workspace-admission.js'

const secret = z.string().regex(/^[a-f0-9]{64}$/)
const origin = z.string().url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && url.origin === value
})
const runtimeSchema = z.object({
    protocolVersion: z.literal(1), launchNonce: z.string().uuid(), buildId: z.string().min(1), workspaceId: z.number().int().positive(),
    dataRoot: z.string(), engineRoot: z.string().optional(), installRoot: z.string().optional(), installId: z.string().uuid().optional(), app: z.object({ origin, sessionToken: secret }), engine: z.object({ origin, apiKey: secret }),
})

export async function desktopRunCommand(): Promise<void> {
    if (!desktopApp() || !process.send || !process.env.RERUN_DESKTOP_RUNTIME_FILE) throw new Error('Desktop engine requires an app-managed launch')
    const runtime = runtimeSchema.parse(JSON.parse(await readFile(process.env.RERUN_DESKTOP_RUNTIME_FILE, 'utf8')))
    const config = env()
    if (config.RERUN_HOST !== '127.0.0.1' || Number(new URL(runtime.engine.origin).port) !== config.RERUN_PORT || config.RERUN_HUB_BASE_URL !== runtime.app.origin) throw new Error('Desktop engine address mismatch')
    if (!config.RERUN_API_KEY || config.RERUN_API_KEY.length !== 64 || !timingSafeEqual(Buffer.from(config.RERUN_API_KEY), Buffer.from(runtime.engine.apiKey))) throw new Error('Desktop engine credential mismatch')
    if (!secret.safeParse(process.env.RERUN_DESKTOP_SECRET_KEY).success) throw new Error('Desktop credential encryption is unavailable')
    if (runtime.workspaceId !== Number(process.env.RERUN_DESKTOP_WORKSPACE_ID ?? 1)) throw new Error('Desktop workspace identity mismatch')
    const installRoot = resolve(process.env.RERUN_DESKTOP_INSTALL_DIR ?? runtime.dataRoot)
    if (runtime.installRoot && resolve(runtime.installRoot) !== installRoot) throw new Error('Desktop install root mismatch')
    const expectedContext = runtime.workspaceId === 1 ? installRoot : resolve(installRoot, 'workspaces', String(runtime.workspaceId))
    if (resolve(runtime.dataRoot) !== expectedContext) throw new Error('Desktop workspace data root mismatch')
    const expectedEngineRoot = resolve(installRoot, 'workspaces', String(runtime.workspaceId), 'engine')
    if (runtime.engineRoot && resolve(runtime.engineRoot) !== expectedEngineRoot) throw new Error('Desktop engine root escaped its workspace')
    if (runtime.workspaceId !== 1 && !runtime.engineRoot) throw new Error('Desktop engine storage identity is missing')
    if (await realpath(config.RERUN_DATA_DIR) !== await realpath(expectedEngineRoot)) throw new Error('Desktop engine data root mismatch')
    if (runtime.workspaceId !== 1 && !runtime.installId) throw new Error('Desktop workspace install identity is missing')
    const owner = z.object({ installId: z.string().uuid(), workspaceId: z.number().int().positive() }).parse(JSON.parse(await readFile(resolve(expectedEngineRoot, 'desktop-owner.json'), 'utf8')))
    if (owner.workspaceId !== runtime.workspaceId || runtime.installId && owner.installId !== runtime.installId) throw new Error('Desktop engine owner mismatch')
    let stopping = false
    bindExternalMcpRuntimeAuthority({ read: () => {
        let admissionsFrozen = true
        try { assertDesktopRunAdmission(); admissionsFrozen = false } catch {}
        return { installId: owner.installId, workspaceId: runtime.workspaceId, launchNonce: runtime.launchNonce, admissionsFrozen, stopping }
    } })
    bindSharedMutationWorkspace(async () => {
        const epoch = assertDesktopRunAdmission()
        return { workspaceId: runtime.workspaceId, assertCurrent: async signal => {
            signal.throwIfAborted()
            assertDesktopRunAdmission(epoch)
            if (stopping) throw new Error('This workspace is stopping.')
        } }
    })
    await prepareDataDir()
    await ensureForeman()
    await initializeDesktopBrainStore()
    // The schema version persists, but this process-local binding must be recreated.
    await initializeDesktopCompanyBriefStore()
    await initializeDesktopExternalMcp()
    const customProviders = bindDesktopCustomProviders(runtime.workspaceId, runtime.launchNonce, () => stopping)
    const opencodeConnection = createDesktopOpencodeConnectionStore({
        path: resolve(expectedEngineRoot, 'desktop-opencode.env'),
        workspaceId: runtime.workspaceId,
        admit(epoch) {
            if (stopping) throw new Error('This workspace is stopping.')
            return assertDesktopRunAdmission(epoch)
        },
        knownModels: () => desktopOpencodeListedModels(runtime.workspaceId).map(model => model.id),
        readDefault: readBoxDefault,
    })
    registerDesktopOpencodeConnection(opencodeConnection)
    const subscriptionLogin = bindDesktopSubscriptionDeviceLogin()
    observeDesktopAdmissionChange(async () => {
        let frozen = true
        try { assertDesktopRunAdmission(); frozen = false } catch {}
        if (frozen) {
            customProviders.abort()
            await Promise.all([getExternalMcpService().close(), subscriptionLogin.cancelPending(), drainDesktopSubscriptionTurns()])
        }
    })
    registerExternalMcpDispatch(createExternalMcpUiDispatch({ recheck: input => getExternalMcpService().recheck(input) }))
    const lifetime = new AbortController()
    let triggers: Awaited<ReturnType<typeof createDesktopTriggerRuntime>> | undefined
    let triggerTools: ReturnType<typeof createDesktopTriggerToolRuntime> | undefined
    let schedules: Awaited<ReturnType<typeof bindDesktopSchedules>> | undefined
    let scheduleTools: Awaited<ReturnType<typeof createDesktopScheduleToolRuntime>> | undefined
    let stopScheduler: ReturnType<typeof startScheduler> | undefined
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
    const ready = { status: 'ready', protocolVersion: 1, launchNonce: runtime.launchNonce, buildId: runtime.buildId, workspaceId: runtime.workspaceId }
    const claudeLogin = bindDesktopClaudePlanAuth(runtime.launchNonce)
    app.get('/desktop/claude-login', async c => c.json(await claudeLogin.status()))
    app.post('/desktop/claude-login', async c => {
        const parsed = desktopClaudePlanActionSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid sign-in action.' }, 400)
        return c.json(await claudeLogin.action(parsed.data, c.req.raw.signal))
    })
    app.get('/desktop/codex-login', async c => c.json(await codexLoginStatus()))
    app.get('/desktop/provider-usage', async c => c.json(await readDesktopProviderUsage(), 200, { 'Cache-Control': 'no-store' }))
    // Downloaded tool versions take over from the built-in copies before the first reply can start.
    keepDesktopPlanLimits()
    const cliUpdates = bindDesktopCliUpdates(installRoot)
    void cliUpdates.restore().catch(() => {})
    app.get('/desktop/cli-updates', async c => c.json(await cliUpdates.status(), 200, { 'Cache-Control': 'no-store' }))
    app.post('/desktop/cli-updates', async c => {
        const parsed = desktopCliUpdateActionSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid update action.' }, 400)
        return c.json(await cliUpdates.action(parsed.data), 200, { 'Cache-Control': 'no-store' })
    })
    app.get('/desktop/subscription-providers', c => c.json({
        'grok-build': { runtimeAvailable: desktopSubscriptionRunnerAvailable('grok-build') },
        'kimi-code': { runtimeAvailable: desktopSubscriptionRunnerAvailable('kimi-code') },
        devin: { runtimeAvailable: desktopSubscriptionRunnerAvailable('devin') },
    }, 200, { 'Cache-Control': 'no-store' }))
    const subscriptionStatus = () => {
        const state = subscriptionLogin.snapshot()
        for (const provider of ['grok-build', 'kimi-code', 'devin'] as const) {
            if (state[provider].phase !== 'approved') continue
            const catalog = readDesktopSubscriptionCatalog(provider)
            state[provider] = {
                phase: 'approved', canRefreshModels: true,
                chatReady: !!catalog && desktopSubscriptionChatAvailable(provider),
                ...(catalog && { models: catalog.models }),
            }
        }
        return state
    }
    app.get('/desktop/subscription-login', c => c.json(subscriptionStatus(), 200, { 'Cache-Control': 'no-store' }))
    app.post('/desktop/subscription-login', async c => {
        const parsed = desktopSubscriptionLoginAction.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid subscription sign-in action.' }, 400)
        try { assertDesktopRunAdmission() }
        catch { return c.json({ error: 'This workspace is switching. Try again when it is ready.' }, 409) }
        try {
            if (parsed.data.action === 'refresh-models') {
                await refreshDesktopSubscriptionCatalog(parsed.data.provider, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(180_000)]))
            } else {
                await subscriptionLogin.action(parsed.data)
            }
            return c.json(subscriptionStatus(), 200, { 'Cache-Control': 'no-store' })
        } catch {
            return c.json({ error: parsed.data.action === 'refresh-models'
                ? 'The subscription model list could not be refreshed.'
                : 'Subscription sign-in could not be confirmed.' }, 409)
        }
    })
    app.post('/desktop/codex-login', async c => {
        const parsed = desktopCodexAction.safeParse((await c.req.json().catch(() => null))?.action)
        if (!parsed.success) return c.json({ error: 'Invalid sign-in action.' }, 400)
        return c.json(await codexLoginAction(parsed.data))
    })
    app.get('/health', c => initialized ? c.json(ready) : c.json({ status: 'starting' }, 503))
    await initializeComputerLaunchers()
    const screen = bindIsolatedScreen(runtime)
    const computerPanel = bindDesktopComputerPanel(runtime)
    const guestShell = bindDesktopGuestShell(runtime)
    const toolInstall = bindDesktopToolInstall(runtime)
    const foreman = bindDesktopForeman(runtime)
    const delegation = bindDesktopDelegation(runtime.launchNonce)
    installDesktopDelegation(delegation)
    app.route('/desktop/computer-panel', computerPanel.routes)
    app.route('/desktop/custom-providers', customProviders.routes)
    app.route('/desktop/opencode/connection', desktopOpencodeConnectionRoutes(opencodeConnection, runtime.launchNonce))
    app.route('/desktop/coworker-share-database', createPrivateDatabaseShareRoutes(runtime.workspaceId))
    app.route('/desktop/foreman', createDesktopForemanRoutes(undefined, { workspaceId: runtime.workspaceId, launchNonce: runtime.launchNonce }))
    app.route('/desktop/external-mcp', createDesktopExternalMcpRouter(getExternalMcpService))
    app.route('/desktop/tool-install', toolInstall.routes)
    app.route('/agents/:id/screen', screen.routes)
    app.route('/desktop/delegation', delegation.routes)
    app.route('/desktop/triggers', createDesktopTriggerRoutes(readDesktopTriggerRuntime, runtime.launchNonce))
    app.route('/', createServer())
    let server: Server
    const shutdown = async () => {
        if (shutdownActive) return
        shutdownActive = true
        stopping = true
        cliUpdates.stop()
        const diagnostic = createDesktopStopDiagnostic(expectedEngineRoot, runtime)
        lifetime.abort()
        stopScheduler?.()
        const closed = diagnostic.track('http-listener', () => new Promise<void>(done => server.close(() => done())))
        stopCodexLogin()
        claudeLogin.stop()
        // Close admissions before waiting for any preparation. Callback delivery is best effort
        // during teardown; failure must never reopen either local service or prevent shutdown.
        const closing = Promise.allSettled([
            diagnostic.track('schedule-admission', () => schedules?.close()),
            diagnostic.track('trigger-runtime', () => Promise.resolve(triggerTools?.close()).then(() => triggers?.close())),
            diagnostic.track('delegation', () => delegation.close()),
            diagnostic.track('mcp-callback', () => stopDesktopMcp()),
            diagnostic.track('skill-proposals', () => stopDesktopSkillProposals()),
            diagnostic.track('screen-viewer', () => screen.close()).then(() => diagnostic.track('isolated-screens', () => shutdownIsolatedScreens(AbortSignal.timeout(25_000)))),
            diagnostic.track('semantic-memory', () => shutdownDesktopSemanticMemory()),
            diagnostic.track('schedule-tools', () => scheduleTools?.close()),
            diagnostic.track('tool-install', () => toolInstall.close()),
            diagnostic.track('foreman', () => foreman.close()),
            diagnostic.track('custom-providers', () => customProviders.close()),
            diagnostic.track('computer-panel', () => computerPanel.close()),
            diagnostic.track('guest-shell', () => guestShell.close()),
            diagnostic.track('external-mcp', () => closeDesktopExternalMcp()),
            diagnostic.track('claude-workers', () => stopDesktopClaudeWorkers()),
            diagnostic.track('subscription-runners', async () => {
                await subscriptionLogin.close()
                await stopDesktopSubscriptionRunners()
            }),
        ])
        // Preparing scheduled runs already register a controller in runAgent. Signal those
        // before draining preparation, otherwise a stuck provider can prevent its own Stop.
        await Promise.allSettled([closing, diagnostic.track('run-abort-initial', () => abortAllRuns()), diagnostic.track('scheduler-preparation', () => stopScheduler?.drain())])
        // Schedule admission closes synchronously; its final UI notification is
        // best effort and owns no child process. Only tool drains require ACK.
        const shutdownFailures = (await closing).slice(1).filter(result => result.status === 'rejected').length
        const remaining = await Promise.allSettled([
            diagnostic.track('run-abort-final', () => abortAllRuns()),
            diagnostic.track('mcp-pool', () => closeAllMcp()),
            diagnostic.track('native-workers', () => stopAllDesktopNativeWorkers()),
        ])
        server.closeAllConnections()
        await closed
        const failed = shutdownFailures + remaining.filter(result => result.status === 'rejected').length
        await diagnostic.finish(failed > 0)
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
            await reconcileIsolatedScreens(runtime.launchNonce, AbortSignal.timeout(20_000))
            if (stopping) return
            const recovered = await recoverNativeWritebackOutbox(bundle => sendNativeWriteback(bundle, lifetime.signal))
            if (recovered.retained.length) logger.warn({ count: recovered.retained.length }, 'Native file review captures retained for later recovery')
            if (stopping) return
            scheduleTools = await createDesktopScheduleToolRuntime(runtime)
            if (stopping) { await scheduleTools.close().catch(() => {}); return }
            schedules = await bindDesktopSchedules(runtime)
            if (stopping) { await schedules.close().catch(() => {}); return }
            await bindDesktopCoworkerCalls(runtime)
            if (stopping) return
            triggers = await createDesktopTriggerRuntime(runtime, { loopbackIngress: true })
            if (stopping) { await triggers.close().catch(() => {}); return }
            triggerTools = createDesktopTriggerToolRuntime(triggers)
            await delegation.initialize()
            if (stopping) return
            initialized = true
            stopScheduler = startScheduler()
            process.send?.({ type: 'ready', ...ready })
        })().catch(error => { logger.error({ err: String(error) }, 'desktop schedule startup failed'); void shutdown() })
    }) as Server
    screen.attach(server)
    process.on('message', message => { if ((message as { type?: string })?.type === 'stop') void shutdown() })
    process.once('disconnect', () => { void shutdown() })
    process.once('SIGTERM', () => { void shutdown() })
    process.once('SIGINT', () => { void shutdown() })
}
