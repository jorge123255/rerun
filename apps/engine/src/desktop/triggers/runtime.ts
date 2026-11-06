import { z } from 'zod'
import { logger } from '../../lib/logger.js'
import type { DesktopTriggerEngineBinding } from './binding.js'
import { desktopTriggerChatSchema } from '@rerun/contracts'
import { getAgent } from '../../agents/registry.js'
import { listAgentIdsOnDisk } from '../../agents/loader.js'
import { getSystemDb } from '../../db/systemDb.js'
import { createSession, getSession } from '../../db/repos/sessions.js'
import { cancelRun, getRun, setRunContext } from '../../db/repos/runs.js'
import { sendNotification } from '../../runtime/notify.js'
import { startHeadlessRun } from '../../runtime/headless-run.js'
import { abortRun, waitForRunCancellation } from '../../runtime/run-control.js'
import { markFired } from '../../triggers/loader.js'
import { beginDesktopAgentWork, desktopDeletionActive } from '../agent-lifecycle.js'
import { bindDesktopTriggers } from './binding.js'
import { createDesktopTriggerNetworkingFromOrigin } from './networking.js'
import { listDesktopTriggerDefinitions, readDesktopTriggerDefinition, replaceDesktopTriggerDefinition } from './definitions.js'
import type { DesktopTriggerAuthority } from './types.js'

type Runtime = { launchNonce: string; app: { origin: string }; engine: { apiKey: string } }
const ownerSchema = z.strictObject({ localAgentId: z.string(), engineAgentId: z.string(), enabled: z.boolean(), deleting: z.boolean() })
let currentRuntime: DesktopTriggerEngineBinding | null = null
export const readDesktopTriggerRuntime = () => currentRuntime

const modelSchema = z.object({ connectionId: z.string().min(1), model: z.string().min(1) })

/** One instance per engine launch, initialized before admissions; no public listener is opened. */
export async function createDesktopTriggerRuntime(runtime: Runtime, options: { loopbackIngress?: boolean; fetch?: typeof fetch } = {}) {
    const origin = new URL(runtime.app.origin)
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port) throw new Error('Trigger ingress must use the app loopback origin')
    let closed = false
    const active = () => { if (closed) throw new Error('Triggers are stopping') }
    const controllers = new AbortController()
    const pending = new Set<Promise<unknown>>()
    const held = new Map<string, () => void>()
    const running = new Map<string, string>()
    async function callback(op: string, payload: unknown) {
        active()
        const response = await (options.fetch ?? fetch)(`${runtime.app.origin}/api/desktop/internal/triggers`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'desktop.trigger', launchNonce: runtime.launchNonce, op, payload }), signal: AbortSignal.any([controllers.signal, AbortSignal.timeout(10000)]) })
        if (!response.ok || !response.body) throw new Error('Trigger authorization unavailable')
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
        try {
            while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65536) throw new Error('Invalid trigger acknowledgement'); chunks.push(part.value) }
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (value.ok !== true) throw new Error('Trigger request refused')
            active(); return value.result as unknown
        } finally { await reader.cancel().catch(() => {}) }
    }
    async function owned(id: string, admission = false) {
        active()
        if (desktopDeletionActive(id)) throw new Error('Coworker is being deleted')
        await recoverOwner(id)
        const result = ownerSchema.parse(await callback(admission ? 'authorize' : 'owner', { engineAgentId: id }))
        if (result.engineAgentId !== id || result.deleting) throw new Error('Coworker identity changed')
        return result
    }
    const authority: DesktopTriggerAuthority = {
        assertActive: active,
        resolveOwnerByEngineId: id => owned(id),
        assertTriggerGrant: async id => { await owned(id, true) },
        assertSetupClear: async id => { await callback('setup', { engineAgentId: id }) },
        resolveAutomationModel: async (id, override) => {
            const chosen = modelSchema.parse(await callback('model', { engineAgentId: id, override }))
            return { ...chosen, provider: null }
        },
        startTriggerRun: async input => {
            const release = beginDesktopAgentWork(input.engineAgentId)
            let runId: string | undefined
            try {
                await input.assertActive()
                const agent = await getAgent(input.engineAgentId)
                if (!agent.config.enabled) throw new Error('Enable this coworker to run triggers')
                const session = await createSession(agent.id, input.name, undefined, 'trigger')
                await input.onSessionCreated(session.id)
                await sendNotification({ event: 'agent.session.created', kind: 'info', agentId: agent.id, sessionId: session.id, runId: null, message: `Triggered run: ${input.name}`, title: input.name, source: 'trigger' })
                const assertLaunch = async () => {
                    await input.assertActive()
                    const chosen = await authority.resolveAutomationModel(agent.id, input.model)
                    if (chosen.connectionId !== input.model.connectionId || chosen.model !== input.model.model) throw new Error('Trigger model changed before launch')
                }
                const run = await startHeadlessRun(agent, session.id, input.message, { connectionId: input.model.connectionId!, model: input.model.model! }, { source: 'trigger', slug: input.slug, name: input.name }, {
                    beforeLaunch: assertLaunch,
                    onRunCreated: async id => {
                        runId = id
                        await setRunContext(agent.id, id, { provider: agent.resolved.provider, model: input.model.model!, triggerSource: 'trigger', triggerSlug: input.slug })
                        await input.onRunCreated(id, session.id)
                    },
                })
                running.set(run.runId, agent.id)
                const tracked = run.settled.finally(() => { running.delete(run.runId); release() })
                pending.add(tracked); void tracked.finally(() => pending.delete(tracked)).catch(() => {})
                return { runId: run.runId, sessionId: session.id, settled: tracked }
            } catch (error) {
                if (runId) {
                    try { await authority.cancelExactRun(input.engineAgentId, runId) } catch (cancelError) { held.set(runId, release); running.set(runId, input.engineAgentId); throw cancelError }
                }
                release(); throw error
            }
        },
        cancelExactRun: async (id, runId) => {
            const run = await getRun(id, runId)
            if (!run || run.agentId !== id || run.triggerSource !== 'trigger') throw new Error('Trigger run ownership changed')
            abortRun(runId)
            if (!await waitForRunCancellation(runId)) throw new Error('Trigger run is still stopping')
            const current = await getRun(id, runId)
            if (current?.status === 'running') await cancelRun(id, runId)
            held.get(runId)?.(); held.delete(runId); running.delete(runId)
        },
        readRun: async (id, runId) => (await getRun(id, runId)) ?? null,
        readSession: async (id, sessionId) => (await getSession(id, sessionId)) ?? null,
        adoptTriggerSession: async input => desktopTriggerChatSchema.parse(await callback('adopt', input)),
        routeHuman: async () => { /* The existing run loop persists and publishes human requests. */ },
        ingressOrigin: () => networking.origin(),
        listTriggers: listDesktopTriggerDefinitions,
        readTrigger: readDesktopTriggerDefinition,
        replaceTrigger: replaceDesktopTriggerDefinition,
        writeTrigger: async () => { throw new Error('Use durable trigger definition CAS') },
        rotateTriggerToken: async () => { throw new Error('Use durable trigger definition CAS') },
        deleteTrigger: async () => { throw new Error('Use durable trigger definition CAS') },
        markFired,
    }
    const networking = createDesktopTriggerNetworkingFromOrigin({ enabled: options.loopbackIngress === true, origin: options.loopbackIngress ? runtime.app.origin : null, bindHost: '127.0.0.1', bindPort: Number(origin.port), hostingDecision: 'loopback-only' })
    const binding = bindDesktopTriggers({ getSystemClient: async id => { if (desktopDeletionActive(id)) throw new Error('Coworker deleted'); await getAgent(id); return (await getSystemDb(id)).client }, authority, networking })
    const recovered = new Map<string, Promise<unknown>>()
    function recoverOwner(id: string): Promise<unknown> {
        let ready = recovered.get(id)
        if (!ready) {
            ready = binding.recoverOwner(id).catch(error => { recovered.delete(id); throw error })
            recovered.set(id, ready)
        }
        return ready
    }
    // An orphaned or temporarily unreadable coworker must not prevent the app opening.
    // Each owner's admission still awaits its own successful recovery before doing work.
    for (const id of await listAgentIdsOnDisk()) if (!desktopDeletionActive(id)) {
        try { await recoverOwner(id) } catch { logger.warn({ agentId: id }, 'Desktop trigger history recovery deferred') }
    }
    const result = { ...binding, launchNonce: runtime.launchNonce, close: async () => {
        closed = true
        if (currentRuntime === result) currentRuntime = null
        controllers.abort()
        await binding.close()
        const stopped = await Promise.allSettled([...running].map(([runId, id]) => authority.cancelExactRun(id, runId)))
        if (stopped.some(result => result.status === 'rejected')) throw new Error('Trigger runs are still stopping')
        await Promise.allSettled([...pending])
    } }
    currentRuntime = result
    return result
}
