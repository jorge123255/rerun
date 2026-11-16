import 'server-only'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DesktopActivityDecision, DesktopGithubToolServer } from '@rerun/contracts'
import { remoteMcpTools } from './tools'
import type { RemoteMcpStore } from './store'
import type { remoteMcpRuntime } from './remote'

const id = z.string().min(1).max(200)
const identity = z.object({ engineAgentId: id, sessionId: id, runId: id }).strict()
export type McpRunIdentity = z.infer<typeof identity>
export const desktopMcpBridgeRequest = z.discriminatedUnion('action', [
    identity.extend({ action: z.literal('catalog') }).strict(),
    identity.extend({ action: z.literal('call'), catalogId: z.string().uuid(), capabilityId: z.string().uuid(), toolCallId: id, arguments: z.record(z.string(), z.unknown()) }).strict(),
    identity.extend({ action: z.literal('release'), catalogId: z.string().uuid().optional() }).strict(),
    z.object({ action: z.literal('shutdown') }).strict(),
])
type RequestBody = z.infer<typeof desktopMcpBridgeRequest>
type Definition = { name: string; description: string; inputSchema: Record<string, unknown>; destructive?: boolean; server?: DesktopGithubToolServer; execute(args: Record<string, unknown>, signal: AbortSignal, toolCallId: string): Promise<unknown> }
export type DesktopMcpBridgeExtension = {
    tools(owner: string, run: McpRunIdentity, signal: AbortSignal): Promise<Definition[]>
    releaseRun(owner: string, run: McpRunIdentity): Promise<void>
}
/** Holds a call that asks the person first. `null` lets it run; a string is told to the coworker instead. */
export type DesktopMcpCallAdmission = (call: { owner: string; sessionId: string; tool: string; destructive: boolean; arguments: Record<string, unknown>; /** Where the tool comes from, when the bridge knows: the GitHub check reads it. */ server?: DesktopGithubToolServer }, signal: AbortSignal, note?: (trail: DesktopActivityDecision) => void) => Promise<string | null>
type PublicTool = { capabilityId: string; name: string; description: string; inputSchema: Record<string, unknown> }
type Catalog = {
    id: string; owner: string; identity: McpRunIdentity; controller: AbortController;
    tools: Map<string, Definition>; publicTools: PublicTool[]; calls: Set<string>; expires: ReturnType<typeof setTimeout>;
}

/** HTTP only transports opaque capabilities. Configuration, credentials and the authoritative
 * lifecycle stay in the same UI service used by the management panel. */
export function desktopMcpBridge(store: RemoteMcpStore, runtime: ReturnType<typeof remoteMcpRuntime>, authorize: (identity: McpRunIdentity, signal: AbortSignal) => Promise<string>, extension?: DesktopMcpBridgeExtension, admit?: DesktopMcpCallAdmission) {
    const catalogs = new Map<string, Catalog>()
    const runs = new Map<string, AbortController>()
    const releasedRuns = new Set<string>()
    let closed = false
    const runKey = (value: McpRunIdentity) => JSON.stringify([value.engineAgentId, value.sessionId, value.runId])
    const current = (catalog: Catalog) => {
        catalog.controller.signal.throwIfAborted()
        if (closed || catalogs.get(catalog.id) !== catalog) throw new Error('MCP catalog is no longer available')
    }
    const release = (catalog: Catalog) => {
        catalog.controller.abort(); clearTimeout(catalog.expires)
        releasedRuns.add(runKey(catalog.identity))
        catalogs.delete(catalog.id)
        if (runs.get(runKey(catalog.identity)) === catalog.controller) runs.delete(runKey(catalog.identity))
        const drain = extension?.releaseRun(catalog.owner, catalog.identity) ?? Promise.resolve()
        void drain.catch(() => {})
        return drain
    }
    function shutdown() {
        closed = true; store.lifecycle.shutdown()
        for (const controller of runs.values()) controller.abort()
        runs.clear()
        for (const catalog of catalogs.values()) release(catalog)
    }
    async function handle(body: RequestBody, signal: AbortSignal): Promise<unknown> {
        signal.throwIfAborted()
        if (body.action === 'shutdown') { shutdown(); return { stopped: true } }
        if (closed) throw new Error('MCP is stopped')
        if (body.action === 'catalog') {
            const key = runKey(body)
            // A Stop may arrive before a delayed catalog request. Keep a terminal receipt for
            // that run for this process lifetime instead of reopening remote admission.
            if (releasedRuns.has(key) || runs.has(key) || runs.size >= 32 || releasedRuns.size >= 4_096) throw new Error('MCP catalog admission unavailable')
            const controller = new AbortController()
            runs.set(key, controller)
            const abort = () => controller.abort()
            signal.addEventListener('abort', abort, { once: true })
            const deadline = setTimeout(abort, 60_000)
            let catalog: Catalog | undefined
            try {
                controller.signal.throwIfAborted()
                const owner = await authorize(body, controller.signal)
                controller.signal.throwIfAborted()
                if (closed) throw new Error('MCP is stopped')
                catalog = {
                    id: randomUUID(), owner, identity: { engineAgentId: body.engineAgentId, sessionId: body.sessionId, runId: body.runId },
                    controller, tools: new Map(), publicTools: [], calls: new Set(),
                    expires: setTimeout(() => { if (catalog) release(catalog) }, 60 * 60_000),
                }
                catalog.expires.unref?.()
                catalogs.set(catalog.id, catalog)
                const definitions: Definition[] = [...await remoteMcpTools(owner, store, runtime, controller.signal), ...await extension?.tools(owner, catalog.identity, controller.signal) ?? []]
                current(catalog)
                if (await authorize(body, controller.signal) !== owner) throw new Error('MCP owner changed')
                current(catalog)
                const names = new Set<string>()
                for (const definition of definitions) {
                    if (names.has(definition.name) || names.size >= 256) throw new Error('MCP tool name collision')
                    names.add(definition.name)
                    const capabilityId = randomUUID()
                    catalog.tools.set(capabilityId, definition)
                    catalog.publicTools.push({ capabilityId, name: definition.name, description: definition.description, inputSchema: definition.inputSchema })
                }
                if (Buffer.byteLength(JSON.stringify(catalog.publicTools)) > 1_048_576) throw new Error('MCP catalog exceeds limit')
                return { catalogId: catalog.id, tools: catalog.publicTools }
            } catch (error) {
                if (catalog) await release(catalog)
                else { controller.abort(); if (runs.get(key) === controller) runs.delete(key) }
                throw error
            } finally { clearTimeout(deadline); signal.removeEventListener('abort', abort) }
        }
        if (body.action === 'release' && !body.catalogId) {
            const key = runKey(body), pending = runs.get(key)
            releasedRuns.add(key)
            pending?.abort(); runs.delete(key)
            for (const catalog of catalogs.values()) if (runKey(catalog.identity) === key) await release(catalog)
            return { released: true }
        }
        const catalog = catalogs.get(body.catalogId!)
        if (!catalog || runKey(catalog.identity) !== runKey(body)) throw new Error('MCP capability belongs to another run')
        if (body.action === 'release') { await release(catalog); return { released: true } }
        current(catalog)
        const combined = AbortSignal.any([signal, catalog.controller.signal])
        if (await authorize(body, combined) !== catalog.owner) throw new Error('MCP owner changed')
        current(catalog); combined.throwIfAborted()
        const definition = catalog.tools.get(body.capabilityId)
        if (!definition || catalog.calls.has(body.toolCallId) || catalog.calls.size >= 256) throw new Error('MCP call unavailable or already submitted')
        if (Buffer.byteLength(JSON.stringify(body.arguments)) > 65_536) throw new Error('MCP arguments exceed limit')
        // Never repeat a remote side effect after a lost response, even if the caller retries.
        catalog.calls.add(body.toolCallId)
        // An action that asks first is answered here, before anything reaches the connector.
        // What was decided travels back beside the result, for the engine's activity trail.
        let trail: DesktopActivityDecision | undefined
        const held = await admit?.({ owner: catalog.owner, sessionId: catalog.identity.sessionId, tool: definition.name, destructive: definition.destructive === true, arguments: body.arguments, ...(definition.server && { server: definition.server }) }, combined, said => { trail = said })
        current(catalog); combined.throwIfAborted()
        if (typeof held === 'string') return { toolCallId: body.toolCallId, result: { source: 'remote_mcp', untrusted: true, result: { isError: true, content: [{ type: 'text', text: held }] } }, ...(trail && { trail }) }
        const result = await definition.execute(body.arguments, combined, body.toolCallId)
        if (await authorize(body, combined) !== catalog.owner) throw new Error('MCP owner changed')
        current(catalog); combined.throwIfAborted()
        return { toolCallId: body.toolCallId, result, ...(trail && { trail }) }
    }
    return { handle, shutdown, invalidateOwner: (owner: string) => { for (const catalog of catalogs.values()) if (catalog.owner === owner) release(catalog) } }
}
