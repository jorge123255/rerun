import { tool, type ToolSet } from 'ai'
import { Hono } from 'hono'
import { z } from 'zod'
import type { RunContext } from '../../runtime/context.js'
import { desktopApp } from '../policy.js'
import { hasDesktopToolGrant } from '../tool-grants.js'
import { delegationClient } from './client.js'
import { createDesktopDelegationHost } from './host.js'
import { createDelegationRuntime, orderedDelegationResult } from './runtime.js'
import { delegationInputSchema } from './tools.js'
import { stopSchema } from './protocol.js'

/** Construct once after the UI migration and interrupted-run recovery, before chat admission. */
export function bindDesktopDelegation(launchNonce: string) {
    if (!desktopApp() || !launchNonce) throw new Error('Desktop delegation is unavailable')
    const closing = new AbortController(), client = delegationClient(launchNonce, closing.signal)
    const concrete = createDesktopDelegationHost(client, launchNonce)
    const runtime = createDelegationRuntime(client.store, concrete.host, client.receipts)
    let ready = false, stopped = false
    const routes = new Hono()
    routes.post('/stop', async c => {
        try {
            if (!ready || stopped) return c.json({ error: 'Delegation is recovering' }, 409)
            const reader = c.req.raw.body?.getReader(); if (!reader) throw new Error('Missing body')
            const chunks: Uint8Array[] = []; let size = 0
            const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)])
            const cancel = () => { void reader.cancel().catch(() => {}) }; signal.addEventListener('abort', cancel, { once: true })
            try { for (;;) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break; size += part.value.byteLength; if (size > 4096) throw new Error('Body too large'); chunks.push(part.value) } }
            finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}) }
            const body = z.strictObject({ launchNonce: z.literal(launchNonce), source: z.strictObject({ parentAgentId: z.string().min(1).max(200), parentSessionId: z.string().min(1).max(200) }), request: stopSchema }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            // This router remains behind the engine bearer middleware. Only the UI's
            // authenticated, CSRF-checked ownership route sends a public Stop identity.
            return c.json({ delegation: await runtime.stop(body.source, body.request) })
        } catch { return c.json({ error: 'Stop is not confirmed. Retry the same request.' }, 409) }
    })
    return {
        routes,
        async initialize() { if (stopped) throw new Error('Delegation stopped'); await runtime.reconcile(); ready = true },
        tools(ctx: RunContext): ToolSet {
            if (!ready || stopped || ctx.agent.config.ephemeral || !ctx.runId || !ctx.abortSignal || !hasDesktopToolGrant(ctx.agent.config, 'delegate')) return {}
            return { delegate_tasks: tool({ description: 'Delegate self-contained tasks to fresh isolated sub-coworkers, up to four at once. They use this turn’s model and only permitted public web_fetch. They receive only the explicit task and context, return text, and cannot read private files or memory, write files, use native tools, contact apps, ask questions or delegate again.', inputSchema: delegationInputSchema,
                execute: async (input, options) => {
                    if (!options.toolCallId || stopped) throw new Error('Trusted current invocation required')
                    const signal = AbortSignal.any([ctx.abortSignal!, ...(options.abortSignal ? [options.abortSignal] : [])])
                    const { source } = await client.authority({ engineAgentId: ctx.agent.id, sessionId: ctx.sessionId, runId: ctx.runId!, toolCallId: options.toolCallId }, signal)
                    const release = concrete.register(source, ctx)
                    try { return orderedDelegationResult(await runtime.execute(source, input, signal)) }
                    finally { release() }
                },
            }) }
        },
        async close() { stopped = true; ready = false; try { await runtime.shutdown() } finally { closing.abort() } },
    }
}
export type DesktopDelegationBinding = ReturnType<typeof bindDesktopDelegation>
let installed: DesktopDelegationBinding | undefined
export function installDesktopDelegation(binding: DesktopDelegationBinding) { if (installed && installed !== binding) throw new Error('Delegation already bound'); installed = binding }
export function readDesktopDelegation() { return installed }
