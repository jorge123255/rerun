import { randomUUID } from 'node:crypto'
import { TOOL_KEYS, desktopCodexGrantIds, desktopRerunGrantIds } from '@rerun/contracts'
import { agentConfigSchema, type LoadedAgent } from '../../agents/types.js'
import { isUsable } from '../../agents/availability.js'
import { findConnection } from '../../connections/registry.js'
import { getRun, cancelRun } from '../../db/repos/runs.js'
import { createSession } from '../../db/repos/sessions.js'
import { startHeadlessRun } from '../../runtime/headless-run.js'
import { abortRun, sessionClaim, waitForRunCancellation } from '../../runtime/run-control.js'
import type { AgentRun } from '../../runtime/loop.js'
import type { RunContext } from '../../runtime/context.js'
import { closeSystemDb } from '../../db/systemDb.js'
import { closeAgentDb } from '../../db/agentDb.js'
import { unloadAgent } from '../../agents/registry.js'
import { forgetCodexThread } from '../../agents/codex-threads.js'
import { readAgentConfig } from '../../agents/loader.js'
import { desktopDeletionActive, persistDesktopAgentDeletion, withDesktopAgentDeletion } from '../agent-lifecycle.js'
import { hasDesktopToolGrant } from '../tool-grants.js'
import { redactCoworkerCallText } from '../coworker-calls/prepare.js'
import { isFailureResult } from '../../tools/builtin/sub-run-watch.js'
import { registerDelegationChild } from './child-scope.js'
import { allocateDelegationDirectory, cleanupDelegationDirectory, DELEGATION_SOUL, initializeDelegationDirectory, inspectDelegationDirectory, assertDelegationManifest } from './resources.js'
import type { DelegationClient } from './client.js'
import type { Allocation } from './protocol.js'
import type { Authority, DelegationHost, Resource, Source } from './types.js'

const sourceKey = (s: Source) => JSON.stringify([s.parentAgentId, s.parentSessionId, s.parentRunId, s.toolCallId])
const resourceOf = (row: Allocation): Resource => ({ token: row.token, identity: row.identity })
const sourceOf = (source: Source): Source => ({ parentAgentId: source.parentAgentId, parentSessionId: source.parentSessionId, parentRunId: source.parentRunId, toolCallId: source.toolCallId })
export function createDesktopDelegationHost(client: DelegationClient, epoch: string) {
    const parents = new Map<string, RunContext>()
    const running = new Map<string, { run?: AgentRun; launching?: Promise<AgentRun>; runId?: string; stopped: boolean; drained: Promise<void>; release: () => void }>()
    async function allocation(resource: Resource) { const row = await client.resource(resource.token); if (row.identity !== resource.identity) throw new Error('Delegation resource changed'); return row }
    async function patch(row: Allocation, value: Partial<Allocation>) { return client.saveResource({ ...row, ...value, revision: randomUUID() }, row.revision) }
    async function current(source: Source, signal: AbortSignal): Promise<Authority> {
        const ctx = parents.get(sourceKey(source)); if (!ctx?.runId || !ctx.abortSignal || ctx.agent.config.ephemeral || desktopDeletionActive(ctx.agent.id)) throw new Error('Delegation source unavailable')
        signal.throwIfAborted(); ctx.abortSignal.throwIfAborted()
        const config = await readAgentConfig(ctx.agent.id)
        if (!config.enabled || !hasDesktopToolGrant(config, 'delegate') || sessionClaim(ctx.sessionId)?.runId !== ctx.runId) throw new Error('Delegation permission changed')
        const row = await getRun(ctx.agent.id, ctx.runId)
        if (!row || row.agentId !== ctx.agent.id || row.sessionId !== ctx.sessionId || row.status !== 'running' || row.model && row.model !== ctx.model || row.provider && row.provider !== ctx.provider) throw new Error('Delegation parent run changed')
        const checked = await client.authority({ engineAgentId: ctx.agent.id, sessionId: ctx.sessionId, runId: ctx.runId, toolCallId: source.toolCallId }, signal)
        if (sourceKey(checked.source) !== sourceKey(source)) throw new Error('Delegation public identity changed')
        const connectionId = ctx.agent.resolved.connection?.id
        const connection = connectionId ? await findConnection(connectionId) : null
        if (!connectionId || !isUsable(connection, ctx.model) || connection?.config.provider !== ctx.provider) throw new Error('Delegation model unavailable')
        signal.throwIfAborted(); ctx.abortSignal.throwIfAborted()
        return { connectionId, model: ctx.model, tools: checked.webFetch && hasDesktopToolGrant(config, 'webFetch') ? ['web_fetch'] : [] }
    }
    const host: DelegationHost = {
        current, isolatedTool: name => name === 'web_fetch',
        async allocate(source, taskId) {
            const ctx = parents.get(sourceKey(source)); if (!ctx?.abortSignal) throw new Error('Parent unavailable')
            const check = async () => { await current(source, ctx.abortSignal!) }
            await check()
            let row = await client.request<Allocation>('allocate', { source: sourceOf(source), taskId })
            if (row.epoch !== epoch || row.phase !== 'reserved' || row.rootIdentity) throw new Error('Delegated work was already allocated; it will not replay')
            const identity = await allocateDelegationDirectory(row, check)
            row = await patch(row, { rootIdentity: identity, manifest: [] })
            return resourceOf(row)
        },
        async recover(source, taskId) { const row = await client.request<Allocation | null>('recover', { source: sourceOf(source), taskId }); return row ? resourceOf(row) : null },
        async create(resource, input) {
            let row = await allocation(resource)
            if (row.epoch !== epoch || row.phase !== 'reserved' || !row.rootIdentity || running.has(row.token)) throw new Error('Delegation child cannot replay')
            const parent = parents.get(sourceKey(row.source)); if (!parent) throw new Error('Parent unavailable')
            const check = async () => { input.signal.throwIfAborted(); const value = await current(row.source, input.signal); if (value.connectionId !== input.connectionId || value.model !== input.model) throw new Error('Delegation model changed') }
            await check()
            const connection = await findConnection(input.connectionId)
            if (!isUsable(connection, input.model) || connection?.config.provider !== parent.provider) throw new Error('Delegation model unavailable')
            const config = agentConfigSchema.parse({ name: 'Delegated task', ephemeral: true, enabled: true, connectionId: input.connectionId, provider: parent.provider, model: input.model,
                tools: { ...Object.fromEntries(TOOL_KEYS.map(key => [key, false])), desktopToolGrants: { ...Object.fromEntries(desktopRerunGrantIds.map(key => [key, false])), webFetch: input.tools.includes('web_fetch') }, desktopCodexGrants: Object.fromEntries(desktopCodexGrantIds.map(key => [key, false])) },
                selfImprovement: { enabled: false, allowToolInstall: false, allowSoulEdit: false, autoMemory: false }, mcpServers: [], setup: { required: false } })
            await initializeDelegationDirectory(row, config, check, async manifest => { row = await patch(row, { manifest }) })
            const agent: LoadedAgent = { id: row.childAgentId, config, soul: DELEGATION_SOUL, install: '', env: {}, resolved: { connection, provider: parent.provider, model: input.model } }
            await check()
            const session = await createSession(agent.id, 'Delegated task', undefined, 'delegate')
            const manifest = await inspectDelegationDirectory(row)
            assertDelegationManifest(row, manifest, { runtimeFiles: true })
            row = await patch(row, { sessionId: session.id, phase: 'created', manifest })
            const scope = registerDelegationChild({ agent, sessionId: session.id, runId: null, signal: input.signal, tools: input.tools, authorize: input.authorizeTool })
            let resolveDrained!: () => void
            const live = { stopped: false, drained: new Promise<void>(resolve => { resolveDrained = resolve }), release: scope.close } as { run?: AgentRun; launching?: Promise<AgentRun>; runId?: string; stopped: boolean; drained: Promise<void>; release: () => void }
            running.set(row.token, live)
            let began = false
            const stop = async () => {
                live.stopped = true
                if (live.runId) { abortRun(live.runId); if (!await waitForRunCancellation(live.runId, 25000)) throw new Error('Delegation child is still stopping') }
                if (!began) { scope.close(); resolveDrained() }
            }
            return {
                stop, settled: live.drained,
                async run(progress) {
                    if (began || live.stopped) throw new Error('Delegation child cannot replay')
                    began = true
                    const assert = async () => { if (live.stopped) throw new Error('Delegation stopped'); await check() }
                    const cancelled = () => { void stop().catch(() => {}) }
                    input.signal.addEventListener('abort', cancelled, { once: true })
                    try {
                        live.launching = startHeadlessRun(agent, session.id, input.context ? `${input.context}\n\n---\n\n${input.task}` : input.task, { connectionId: input.connectionId, provider: parent.provider, model: input.model }, { source: 'chat' }, {
                            beforeLaunch: assert, assertActive: assert,
                            onRunCreated: async runId => {
                                live.runId = runId
                                row = await patch(row, { runId, phase: 'running' })
                                scope.runCreated(runId)
                                await assert()
                            },
                        })
                        live.run = await live.launching
                        let text = ''
                        for await (const part of live.run.result.fullStream) {
                            await assert()
                            if (part.type === 'text-delta') { text += part.text; if (Buffer.byteLength(text) > 64000) throw new Error('Delegation result exceeds limit'); await progress({ type: 'text', text }) }
                            else if (part.type === 'finish-step') await progress({ type: 'step' })
                            else if (part.type === 'tool-result' || part.type === 'tool-error') {
                                const name = part.toolName.replace(/^mcp__rerun__/, '')
                                if (!input.tools.includes(name)) throw new Error('Unexpected delegated tool')
                                await progress({ type: 'call', tool: name, failed: part.type === 'tool-error' || isFailureResult(part.output) })
                            }
                        }
                        const outcome = await live.run.settled
                        if (outcome.kind !== 'done' || outcome.pendingToolCallId) throw new Error('Delegation did not finish')
                        await assert(); return text
                    } finally {
                        input.signal.removeEventListener('abort', cancelled)
                        try {
                            if (live.runId) { abortRun(live.runId); if (!await waitForRunCancellation(live.runId, 25000)) throw new Error('Delegated provider not drained') }
                            if (live.run) await live.run.settled
                            scope.close(); resolveDrained()
                        } catch { /* Keep the resource blocked until exact drain can be established. */ }
                    }
                },
            }
        },
        async drain(resource, signal) {
            const row = await allocation(resource), live = running.get(row.token)
            signal.throwIfAborted()
            if (row.phase === 'drained' || row.phase === 'retired') return
            if (live) { live.stopped = true; if (live.runId) { abortRun(live.runId); if (!await waitForRunCancellation(live.runId, 25000)) throw new Error('Delegated provider still active') }; await live.drained; live.release(); running.delete(row.token) }
            else if (row.runId) {
                // Startup interrupted-run repair and process shutdown precede reconciliation.
                // A current process claim without our private handle is never ours to cancel.
                if (row.sessionId && sessionClaim(row.sessionId)) throw new Error('Unowned live child')
                const run = await getRun(row.childAgentId, row.runId)
                if (!run || run.agentId !== row.childAgentId || run.sessionId !== row.sessionId) throw new Error('Delegation run changed')
                if (run.status === 'running') { if (row.epoch === epoch) throw new Error('Unknown current child'); await cancelRun(row.childAgentId, row.runId) }
            }
            closeSystemDb(row.childAgentId); closeAgentDb(row.childAgentId); unloadAgent(row.childAgentId)
            if (row.sessionId) forgetCodexThread(row.childAgentId, row.sessionId)
            await patch(await allocation(resource), { phase: 'drained' })
            signal.throwIfAborted()
        },
        async admitOutputs(resource, _source, _task, signal) {
            const row = await allocation(resource); signal.throwIfAborted()
            if (row.phase === 'retired') return []
            if (row.phase !== 'drained') throw new Error('Delegated resource is not drained')
            if (row.cleanupStarted) return []
            const manifest = await inspectDelegationDirectory(row)
            assertDelegationManifest(row, manifest, { runtimeFiles: row.sessionId !== null })
            await patch(row, { manifest }); return []
        },
        async cleanup(resource, outputs, signal) {
            let row = await allocation(resource)
            if (outputs.length) throw new Error('Delegation file output is unsupported')
            if (row.phase === 'retired') return
            if (row.phase !== 'drained' || !row.manifest) throw new Error('Delegation cleanup is not admitted')
            if (!row.cleanupStarted) row = await patch(row, { cleanupStarted: true })
            await withDesktopAgentDeletion(row.childAgentId, async () => { await cleanupDelegationDirectory(row, signal); await persistDesktopAgentDeletion(row.childAgentId) })
            row = await patch(row, { phase: 'retired' })
        },
        publicText: (_source, text) => redactCoworkerCallText(text).replace(/delegate-[a-f0-9-]{36}/g, 'delegated task'),
    }
    return { host, register: (source: Source, context: RunContext) => { const key = sourceKey(source); if (parents.has(key)) throw new Error('Delegation source already executing'); parents.set(key, context); return () => { if (parents.get(key) === context) parents.delete(key) } } }
}
