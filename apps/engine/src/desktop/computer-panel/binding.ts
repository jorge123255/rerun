import { abortable } from '../web-fetch/transport.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { readAgentConfig } from '../../agents/loader.js'
import { getRun } from '../../db/repos/runs.js'
import { getSession } from '../../db/repos/sessions.js'
import { raw } from '../../db/client.js'
import { beginDesktopAgentWork, desktopDeletionActive } from '../agent-lifecycle.js'
import { readDesktopSetup } from '../setup/service.js'
import { hasDesktopToolGrant } from '../tool-grants.js'
import { isolatedScreenOwner, isolatedScreenSignal } from '../isolated-screen/binding.js'
import { currentScreenRun } from '../isolated-screen/run-owner.js'
import { service } from '../isolated-screen/index.js'
import { createComputerLaunchers } from '../computer-launchers/adapter.js'
import { createLauncherAuthority } from '../computer-launchers/authority.js'
import { computerLauncherStore } from '../computer-launchers/sqlite-store.js'
import { launcherOperationSchema } from '../computer-launchers/contract.js'
const sourceSchema = z.strictObject({ agentId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), sessionId: z.string().min(1).max(200) })
const inputSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('read'), launchNonce: z.string(), source: sourceSchema }),
    z.strictObject({ action: z.literal('launch'), launchNonce: z.string(), source: sourceSchema, runId: z.string().min(1).max(200), generation: z.string().regex(/^[a-f0-9]{32}$/), requestId: z.string().uuid(), app: z.enum(['terminal', 'files']) }),
])
export function bindDesktopComputerPanel(runtime: { launchNonce: string }) {
    const routes = new Hono(), closing = new AbortController()
    async function facts(source: z.infer<typeof sourceSchema>, signal: AbortSignal) {
        signal.throwIfAborted()
        const session = await getSession(source.agentId, source.sessionId)
        const initialConfig = await readAgentConfig(source.agentId)
        if (!session || session.agentId !== source.agentId || initialConfig.ephemeral || desktopDeletionActive(source.agentId)) throw new Error('Conversation changed')
        const status = await service().status(isolatedScreenOwner(source.agentId), signal)
        const running = status.state === 'running' || status.state === 'human' ? await service().running(isolatedScreenOwner(source.agentId), signal) : null
        const current = running ? currentScreenRun(source.agentId) : null
        const run = current?.sessionId === source.sessionId ? await getRun(source.agentId, current.runId) : null
        const live = run?.status === 'running' && run.sessionId === source.sessionId && current?.runId === run.id ? current : null
        const [config, setup] = await Promise.all([readAgentConfig(source.agentId), readDesktopSetup(source.agentId)])
        signal.throwIfAborted()
        if (desktopDeletionActive(source.agentId) || config.ephemeral) throw new Error('Conversation changed')
        if (live && currentScreenRun(source.agentId)?.runId !== live.runId) throw new Error('Active computer run changed')
        return { config, setup, status, running, current: live }
    }
    routes.post('/control', async c => {
        const signal = AbortSignal.any([closing.signal, c.req.raw.signal, AbortSignal.timeout(35000)])
        try {
            const reader = c.req.raw.body?.getReader(); if (!reader) throw new Error('Request missing')
            const chunks: Uint8Array[] = []; let count = 0
            try { for (;;) { signal.throwIfAborted(); const row = await abortable(reader.read(), signal); if (row.done) break; count += row.value.byteLength; if (count > 4096) throw new Error('Request too large'); chunks.push(row.value) } }
            finally { void reader.cancel().catch(() => {}) }
            const input = inputSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            if (input.launchNonce !== runtime.launchNonce) throw new Error('Runtime changed')
            const source = input.source
            const state = await facts(source, isolatedScreenSignal(source.agentId, signal))
            if (input.action === 'read') {
                let pending: { requestId: string; app: 'terminal' | 'files' } | null = null
                if (state.current && state.running) {
                    const rows = await raw().execute({ sql: 'SELECT record FROM desktop_computer_launcher_attempts WHERE owner=? AND generation=? ORDER BY rowid DESC LIMIT 256', args: [source.agentId, state.running.target.sessionGeneration] })
                    for (const row of rows.rows) {
                        const value = JSON.parse(String(row.record)), op = launcherOperationSchema.parse(value.operation)
                        if (op.sessionId === source.sessionId && op.runId === state.current.runId && (value.phase !== 'settled' || ['interrupted', 'timeout'].includes(value.outcome?.status))) { pending = { requestId: op.requestId, app: op.app }; break }
                    }
                }
                const final = await facts(source, isolatedScreenSignal(source.agentId, signal))
                if (final.current?.runId !== state.current?.runId || final.running?.target.sessionGeneration !== state.running?.target.sessionGeneration) throw new Error('Computer owner changed')
                signal.throwIfAborted()
                return c.json({ current: final.current, generation: state.running?.target.sessionGeneration ?? null,
                    coworker: { enabled: final.config.enabled && !final.setup.pending, deleted: false },
                    runtime: state.running ? { kind: 'running' } : { kind: 'unavailable', reason: 'The coworker’s isolated computer is not running.' },
                    humanDriving: final.status.state === 'human',
                    grants: { computer: hasDesktopToolGrant(final.config, 'computer'), browser: hasDesktopToolGrant(final.config, 'browser'), terminalLaunch: hasDesktopToolGrant(final.config, 'terminalLaunch'), filesLaunch: hasDesktopToolGrant(final.config, 'filesLaunch') },
                    capability: { terminalInstalled: state.status.launchers?.terminal === true, filesInstalled: state.status.launchers?.files === true }, pending })
            }
            if (!state.current || state.current.runId !== input.runId || !state.running || state.running.target.sessionGeneration !== input.generation) throw new Error('Active screen run changed')
            const invocation = { ...source, runId: input.runId, requestId: input.requestId, target: state.running.target }
            const authorize = createLauncherAuthority(async (_candidate, stop) => {
                const fresh = await facts(source, stop)
                if (!fresh.running) throw new Error('Computer is stopped')
                return { ...source, runId: input.runId, target: fresh.running.target, enabled: fresh.config.enabled && !fresh.setup.pending, deleting: desktopDeletionActive(source.agentId), active: fresh.current?.runId === input.runId,
                    computer: hasDesktopToolGrant(fresh.config, 'computer'), terminalLaunch: hasDesktopToolGrant(fresh.config, 'terminalLaunch'), filesLaunch: hasDesktopToolGrant(fresh.config, 'filesLaunch') }
            })
            const launchers = createComputerLaunchers({ authorize, withControl: (owner, stop, work) => service().withLauncherControl(owner.target, stop, work), publish: async () => { throw new Error('Human launch does not publish chat screenshots') } }, computerLauncherStore(), { capture: false })
            const release = beginDesktopAgentWork(source.agentId)
            try { return c.json(await launchers.open(invocation, { app: input.app }, isolatedScreenSignal(source.agentId, signal))) }
            finally { release() }
        } catch { return c.json({ error: 'The computer action could not be confirmed. Retry the same request to recover it.' }, 409) }
    })
    return { routes, close() { closing.abort() } }
}
