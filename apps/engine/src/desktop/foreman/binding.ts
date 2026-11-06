import { z } from 'zod'
import { RERUN_PUBLIC_DOCS_CORPUS, FOREMAN_AGENT_ID } from '@rerun/contracts'
import type { RunContext } from '../../runtime/context.js'
import { getAgent } from '../../agents/registry.js'
import { getRun } from '../../db/repos/runs.js'
import { getSession } from '../../db/repos/sessions.js'
import { desktopApp } from '../policy.js'
import { foremanTools } from './tools.js'
import { registerDesktopForemanTools } from './tool-identity.js'
import { createDesktopForemanBridge, type ForemanRuntime } from './bridge.js'
import { createDesktopForemanDocsBridge } from '../foreman-docs/bridge.js'
import { desktopForemanDocsTools } from '../foreman-docs/tools.js'
import { foremanAgentFileTools } from '../foreman-agent-files/tools.js'
type Binding = ReturnType<typeof createDesktopForemanBridge>
let installed: Binding | undefined
let installedDocs: ReturnType<typeof createDesktopForemanDocsBridge> | undefined
export function bindDesktopForeman(runtime: ForemanRuntime, network?: typeof fetch) {
    installed?.close()
    installedDocs?.close()
    const binding = createDesktopForemanBridge(runtime, network)
    installed = binding
    const docs = createDesktopForemanDocsBridge(runtime, network)
    installedDocs = docs
    return { bridge: binding, close() { binding.close(); docs.close(); if (installedDocs === docs) installedDocs = undefined; if (installed === binding) installed = undefined } }
}
export function readDesktopForemanBinding() { return installed }
export async function desktopForemanTools(ctx: RunContext) {
    if (!desktopApp() || ctx.agent.id !== FOREMAN_AGENT_ID || ctx.agent.config.kind !== 'foreman' || !ctx.runId || !ctx.agent.resolved.connection?.id) return { tools: {}, close: async () => {} }
    const runtime = installed
    if (!runtime) throw new Error('Desktop Foreman is not bound to this app launch.')
    const signal = ctx.abortSignal ?? new AbortController().signal
    const identity = { engineAgentId: 'foreman' as const, sessionId: ctx.sessionId, runId: ctx.runId }
    async function current() {
        signal.throwIfAborted()
        if (installed !== runtime) throw new Error('Foreman launch changed.')
        const [agent, session, run] = await Promise.all([getAgent(FOREMAN_AGENT_ID), getSession(FOREMAN_AGENT_ID, identity.sessionId), getRun(FOREMAN_AGENT_ID, identity.runId)])
        signal.throwIfAborted()
        if (installed !== runtime || agent.id !== FOREMAN_AGENT_ID || agent.config.kind !== 'foreman' || !agent.config.enabled || !session || session.agentId !== FOREMAN_AGENT_ID || session.source !== 'dashboard' || session.status !== 'open' || session.originAgentId || session.originSessionId || !run || run.agentId !== FOREMAN_AGENT_ID || run.sessionId !== session.id || run.status !== 'running') throw new Error('This Foreman run is no longer active.')
    }
    await current()
    const trusted = await runtime.binding(identity, signal), binding = trusted.binding
    if (binding.workspaceId !== runtime.workspaceId || binding.runId !== identity.runId || binding.model.connectionId !== ctx.agent.resolved.connection.id || binding.model.model !== ctx.model) throw new Error('Foreman model or conversation binding changed.')
    await current()
    const callId = (value: string, max = 256) => { if (!value.trim() || value.length > max || /[\p{Cc}]/u.test(value)) throw new Error('Foreman tool invocation identity unavailable.') }
    const tools = foremanTools({
        binding,
        async reportShownPlan(input) { callId(input.toolCallId); await current(); const result = await runtime.request({ action: 'show_plan', ...input }, signal); await current(); return result },
        async navigate(input) { callId(input.eventId, 128); await current(); const result = await runtime.request({ action: 'navigate', ...input }, signal); await current(); return z.object({ ok: z.boolean(), error: z.string().optional() }).parse(result) },
        discover: trusted.discovery ? async input => { await current(); const result = await runtime.request({ action: 'discover', ...input }, signal); await current(); return result } : null,
    })
    const docs = installedDocs
    Object.assign(tools, desktopForemanDocsTools({ binding, corpus: RERUN_PUBLIC_DOCS_CORPUS, assertCurrent: current, search: docs ? (input, requestSignal) => docs.search(input, requestSignal ?? signal) : null }))
    Object.assign(tools, foremanAgentFileTools(ctx))
    return { tools: registerDesktopForemanTools(tools), close: async () => {} }
}
