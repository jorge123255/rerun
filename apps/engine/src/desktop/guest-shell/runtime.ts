import { z } from 'zod'
import { desktopGuestShellPackageEvidenceSchema, desktopToolInstallGuestIdentitySchema, type DesktopGuestShellIdentity } from '@rerun/contracts'
import { readAgentConfig } from '../../agents/loader.js'
import { getRun } from '../../db/repos/runs.js'
import { getSystemDb } from '../../db/systemDb.js'
import type { RunContext } from '../../runtime/context.js'
import { desktopDeletionActive } from '../agent-lifecycle.js'
import { desktopInternalJson } from '../internal-client.js'
import { ensureAuthorizedIsolatedScreen, isolatedScreenOwner, isolatedScreenSignal } from '../isolated-screen/binding.js'
import { service } from '../isolated-screen/index.js'
import { readDesktopSetup } from '../setup/service.js'
import { hasDesktopToolGrant } from '../tool-grants.js'
import { desktopGuestShellStore } from './store.js'
import { desktopGuestShellTools } from './tools.js'
import { createDesktopGuestShellTransport } from './transport.js'

/** The active RunContext is the only admission source; no renderer can select a guest or command run. */
export function bindDesktopGuestShell(runtime: { launchNonce: string }) {
    const closing = new AbortController(), work = new Set<Promise<unknown>>()
    async function track<T>(task: Promise<T>) { work.add(task); try { return await task } finally { work.delete(task) } }
    function tools(ctx: RunContext) {
        const actor = { agentId: ctx.agent.id, sessionId: ctx.sessionId, runId: ctx.runId }
        async function permission(signal: AbortSignal) {
            signal.throwIfAborted(); closing.signal.throwIfAborted()
            if (!actor.runId || desktopDeletionActive(actor.agentId)) throw new Error('Guest command owner is unavailable')
            const run = await getRun(actor.agentId, actor.runId)
            const [config, setup] = await Promise.all([readAgentConfig(actor.agentId), readDesktopSetup(actor.agentId)])
            signal.throwIfAborted(); closing.signal.throwIfAborted()
            if (desktopDeletionActive(actor.agentId) || !config.enabled || config.ephemeral || setup.pending || !hasDesktopToolGrant(config, 'guestShell') || !run || run.agentId !== actor.agentId || run.sessionId !== actor.sessionId || run.status !== 'running' || ctx.abortSignal?.aborted) throw new Error('Enable isolated commands for this active coworker before using them.')
        }
        function assertSource(base: Omit<DesktopGuestShellIdentity, 'guest'>, inspect: boolean) {
            if (base.agentId !== actor.agentId || base.sessionId !== actor.sessionId || (!inspect && base.runId !== actor.runId)) throw new Error('Guest command owner changed')
        }
        async function authority(base: Omit<DesktopGuestShellIdentity, 'guest'>, signal: AbortSignal, phase: 'execute' | 'inspect' = 'execute') {
            assertSource(base, phase === 'inspect')
            signal = isolatedScreenSignal(actor.agentId, signal)
            await permission(signal)
            const screen = phase === 'execute' ? await ensureAuthorizedIsolatedScreen(actor.agentId, signal, permission) : await service().running(isolatedScreenOwner(actor.agentId), signal)
            const previous = phase === 'inspect' && 'guest' in base ? desktopToolInstallGuestIdentitySchema.parse(base.guest) : null
            const capability = previous ? { workspaceFingerprint: previous.workspaceFingerprint } : await service().toolInstall(screen.target, { mode: 'probe' }, signal, permission)
            await permission(signal)
            const latest = await service().running(isolatedScreenOwner(actor.agentId), signal)
            if (latest.target.sessionGeneration !== screen.target.sessionGeneration || latest.target.launchNonce !== runtime.launchNonce) throw new Error('The isolated computer changed')
            signal.throwIfAborted()
            return desktopToolInstallGuestIdentitySchema.parse({ ...screen.target, workspaceFingerprint: capability.workspaceFingerprint })
        }
        let opened: Promise<ReturnType<typeof desktopGuestShellStore>> | undefined
        const store = () => opened ??= getSystemDb(actor.agentId).then(db => desktopGuestShellStore(db.client)).catch(error => { opened = undefined; throw error })
        return desktopGuestShellTools(ctx, {
            authority,
            store: { read: async id => (await store()).read(id), begin: async (id, initial) => (await store()).begin(id, initial), complete: async (id, receipt) => (await store()).complete(id, receipt) },
            transport: createDesktopGuestShellTransport(async (identity, body, signal) => {
                assertSource(identity, body.op !== 'guest-shell')
                const cancel = body.op === 'guest-shell-cancel'
                const linked = cancel ? signal : isolatedScreenSignal(actor.agentId, AbortSignal.any([signal, closing.signal]))
                return service().guestShell(identity.guest, body, linked, permission)
            }),
            packageAuthority: async (guest, packages, signal) => {
                await permission(signal)
                const response = await desktopInternalJson('/api/desktop/internal/guest-shell-evidence', { launchNonce: runtime.launchNonce, source: { engineAgentId: actor.agentId, sessionId: actor.sessionId }, guest, packages }, signal, 16384)
                const evidence = z.strictObject({ evidence: z.array(desktopGuestShellPackageEvidenceSchema).max(8) }).parse(response).evidence
                await permission(signal); return evidence
            },
        }, { signal: closing.signal, track, authorize: permission })
    }
    const binding = { tools, async close() { closing.abort(); await Promise.allSettled([...work]) } }
    installed = binding; return binding
}
let installed: ReturnType<typeof bindDesktopGuestShell> | undefined
export function readDesktopGuestShell() { return installed }
