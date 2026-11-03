import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { createServer } from '../../http/server.js'
import { attachDesktopBridge } from '../../desktop/bridge.js'
import { prepareDataDir } from '../../datadir/ladder.js'
import { ensureForeman } from '../../agents/foreman.js'
import { startScheduler } from '../../runtime/scheduler.js'
import { reconcileInterruptedRuns } from '../../runtime/reconcile.js'
import { installBrowserInBackground, installDesktopInBackground } from './update.js'
import { listConnections } from '../../connections/registry.js'
import { refreshStaleCodexPlanLimits } from '../../connections/codex-plan-limits.js'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { closeAllMcp } from '../../tools/mcp-pool.js'
import { loadPairingIdentity, pairWithHub } from '../../pairing/pairing.js'
import { settleLastUpdateOnBoot } from '../../runtime/last-update.js'

export async function runCommand(): Promise<void> {
    loadPairingIdentity()
    if (!env().RERUN_API_KEY?.trim()) throw new Error('An engine API key is required. Configure RERUN_API_KEY before starting the server.')
    await prepareDataDir()
    const lastUpdate = settleLastUpdateOnBoot()
    if (lastUpdate?.status === 'error') logger.warn({ error: lastUpdate.error, commit: lastUpdate.commit }, 'last update did not land')
    await ensureForeman()
    await reconcileInterruptedRuns()
    if (await installBrowserInBackground()) logger.info('chromium missing: installing it in the background')
    if (installDesktopInBackground()) logger.info('desktop missing: installing it in the background')
    void listConnections()
        .then(refreshStaleCodexPlanLimits)
        .catch(err => logger.warn({ err: String(err) }, 'codex plan limits boot read skipped'))
    const stopScheduler = startScheduler()
    logger.info('scheduler started')
    const { RERUN_PORT, RERUN_HOST, RERUN_API_KEY } = env()
    // Node closes any request that takes more than 5 minutes, which a 100 MB upload on a slow link
    // reaches. Raised rather than disabled: a zero here would drop the Slowloris guard with it.
    const serverOptions = { requestTimeout: 30 * 60 * 1000, headersTimeout: 60_000 }
    const server = serve({ fetch: createServer().fetch, port: RERUN_PORT, hostname: RERUN_HOST, serverOptions }, info => {
        logger.info({ port: info.port, host: RERUN_HOST, authenticated: Boolean(RERUN_API_KEY) }, 'rerun-engine listening')
        void pairWithHub()
    })
    attachDesktopBridge(server as Server)
    // The pooled MCP servers are closed before the process goes, within a short grace: one that does
    // not answer its close is left to systemd, which stops the whole cgroup.
    const shutdown = () => {
        stopScheduler()
        const grace = new Promise<void>(resolve => setTimeout(resolve, 2_000).unref())
        void Promise.race([closeAllMcp(), grace]).finally(() => process.exit(0))
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
}
