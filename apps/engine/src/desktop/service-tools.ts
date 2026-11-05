import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { env } from '../config/env.js'
import type { RunContext } from '../runtime/context.js'
import { withAgentLock } from '../agents/lock.js'
import { readAgentConfig } from '../agents/loader.js'
import { beginDesktopAgentWork } from './agent-lifecycle.js'

const marked = new WeakSet<object>()
/** Only actual adapter instances may pass the desktop Codex bridge's dynamic-tool allowlist. */
export function isDesktopServiceTool(value: unknown): boolean { return typeof value === 'object' && value !== null && marked.has(value) }
const catalogSchema = z.object({ catalogId: z.string().uuid(), tools: z.array(z.object({
    capabilityId: z.string().uuid(), name: z.string().regex(/^[\w.-]{1,128}$/), description: z.string().max(8_000), inputSchema: z.record(z.string(), z.unknown()),
}).strict()).max(256) }).strict()

function callbackUrl(): string {
    const url = new URL(env().RERUN_HUB_BASE_URL ?? '')
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
        throw new Error('The desktop Service service is unavailable')
    return `${url.origin}/api/desktop/internal/services`
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason ?? new Error('Service request cancelled')) }
        signal.addEventListener('abort', cancel, { once: true })
        work.then(value => { signal.removeEventListener('abort', cancel); if (signal.aborted) cancel(); else resolve(value) }, error => { signal.removeEventListener('abort', cancel); reject(error) })
        if (signal.aborted) cancel()
    })
}

async function callback(body: unknown, stop: AbortSignal | undefined, timeout: number): Promise<unknown> {
    const signal = AbortSignal.any([...(stop ? [stop] : []), AbortSignal.timeout(timeout)])
    signal.throwIfAborted()
    const apiKey = env().RERUN_API_KEY
    if (!apiKey) throw new Error('The desktop Service service is unavailable')
    const serialized = JSON.stringify(body)
    if (Buffer.byteLength(serialized) > 96_000) throw new Error('Service request exceeds limit')
    const response = await fetch(callbackUrl(), { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: serialized, signal, redirect: 'error', credentials: 'omit' })
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Service service returned no result')
    const chunks: Uint8Array[] = []; let size = 0
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
        while (true) {
            const next = await abortable(reader.read(), signal)
            signal.throwIfAborted()
            if (next.done) break
            size += next.value.byteLength
            if (size > 1_100_000) throw new Error('Service response exceeds limit')
            chunks.push(next.value)
        }
        if (!response.ok) throw new Error('Service request failed. Check this coworker’s permission and connection.')
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally {
        signal.removeEventListener('abort', cancel)
        await abortable(reader.cancel(), AbortSignal.timeout(1_000)).catch(() => {})
    }
}

function boundedSchema(value: Record<string, unknown>) {
    const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
    let count = 0
    while (pending.length) {
        const current = pending.pop()!
        if (++count > 10_000 || current.depth > 32) throw new Error('Service tool schema exceeds limit')
        if (current.value && typeof current.value === 'object') for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 })
    }
    if (value.type !== 'object') throw new Error('Service tool input must be an object')
    return z.fromJSONSchema(value as Parameters<typeof z.fromJSONSchema>[0])
}

export async function desktopServiceTools(ctx: RunContext): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
    // The fresh check below is authoritative. This snapshot only avoids catalog work when off.
    const grants = ctx.agent.config.tools.desktopToolGrants as Record<string, boolean | undefined> | undefined
    if (!ctx.agent.config.enabled || grants?.services !== true) return { tools: {}, close: async () => {} }
    if (!ctx.abortSignal || !ctx.runId) throw new Error('Service requires an active, cancellable run')
    const runSignal = ctx.abortSignal
    const identity = { engineAgentId: ctx.agent.id, sessionId: ctx.sessionId, runId: ctx.runId }
    async function permission(signal: AbortSignal) {
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(5_000)])
        await abortable(withAgentLock(ctx.agent.id, async () => {
            bounded.throwIfAborted()
            const release = beginDesktopAgentWork(ctx.agent.id)
            try {
                const current = await readAgentConfig(ctx.agent.id)
                bounded.throwIfAborted()
                const grant = current.tools.desktopToolGrants as Record<string, boolean | undefined> | undefined
                if (!current.enabled || grant?.services !== true) throw new Error('Service is turned off for this coworker')
            } finally { release() }
        }), bounded)
    }
    await permission(runSignal)
    let catalogId: string | undefined
    let closing: Promise<void> | undefined
    const close = () => closing ??= callback({ action: 'release', ...identity, ...(catalogId ? { catalogId } : {}) }, undefined, 3_000).then(() => {}).catch(() => {})
    const stop = () => { void close() }
    // Explicitly close UI admission even if its HTTP disconnect signal is delivered late.
    // Before discovery responds, the authenticated run identity is the release target.
    runSignal.addEventListener('abort', stop, { once: true })
    if (runSignal.aborted) stop()
    const tools: ToolSet = Object.create(null)
    try {
        const catalog = catalogSchema.parse(await callback({ action: 'catalog', ...identity }, runSignal, 70_000))
        catalogId = catalog.catalogId
        await permission(runSignal)
        for (const definition of catalog.tools) {
            if (Object.hasOwn(tools, definition.name)) throw new Error('Conflicting Service tool names')
            let inputSchema: z.ZodType
            try { inputSchema = boundedSchema(definition.inputSchema) }
            catch { ctx.logger.warn({ tool: definition.name }, 'desktop Service tool schema is unsupported'); continue }
            const executable = tool({
                description: definition.description,
                inputSchema,
                execute: async (args, options) => {
                    const signal = AbortSignal.any([runSignal, ...(options.abortSignal ? [options.abortSignal] : [])])
                    await permission(signal)
                    if (!args || typeof args !== 'object' || Array.isArray(args) || !options.toolCallId) throw new Error('Invalid Service invocation')
                    const release = beginDesktopAgentWork(ctx.agent.id)
                    try {
                        const result = z.object({ toolCallId: z.string(), result: z.object({ source: z.literal('local_service'), untrusted: z.literal(true), result: z.record(z.string(), z.unknown()) }) }).strict()
                            .parse(await callback({ action: 'call', ...identity, catalogId: catalog.catalogId, capabilityId: definition.capabilityId,
                                toolCallId: options.toolCallId, arguments: args }, signal, 130_000))
                        await permission(signal)
                        if (result.toolCallId !== options.toolCallId) throw new Error('Service result belongs to another call')
                        signal.throwIfAborted()
                        // The SDK places this value in the matching tool result. It is never
                        // merged into system instructions; remote failures retain failure state.
                        if (result.result.result.isError === true) throw new Error(JSON.stringify(result.result))
                        return JSON.stringify(result.result)
                    } finally { release() }
                },
            })
            marked.add(executable)
            tools[definition.name] = executable
        }
        return { tools, close: async () => { runSignal.removeEventListener('abort', stop); await close() } }
    } catch (error) { runSignal.removeEventListener('abort', stop); await close(); throw error }
}

