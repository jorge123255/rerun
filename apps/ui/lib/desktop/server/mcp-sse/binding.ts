import 'server-only'
import { createHash, createHmac } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { DesktopMcpSseRef, DesktopMcpSseRequest } from '@rerun/contracts'
import type { McpRunIdentity } from '../mcp/bridge'
import type { RemoteServer } from '../mcp/model'
import type { RemoteMcpStore } from '../mcp/store'
import { publicOAuthAddress } from '../mcp/oauth-network'
import { createPinnedSseNetwork } from './network'
import { createSsePoolState, createSseRuntime } from './runtime'
import { sseControlAdapter, sseToolDefinitions } from './adapters'
import { sqliteSseCallLedger } from './ledger'
import { createSseSettings } from './settings'
import { SseFailure } from './errors'
import type { SseAuthority, SseNetwork } from './types'
import { toToolInputSchema } from './tool-schema'

export type DesktopSseBindingDeps = {
    db: Client
    store: RemoteMcpStore
    key(): Buffer
    shutdownSignal: AbortSignal
    access(owner: string): Promise<{ enabled: boolean; granted: boolean }>
    authorizeRun(run: McpRunIdentity, signal: AbortSignal): Promise<string>
    manage(owner: string, signal: AbortSignal): Promise<() => void>
    refreshCredential(owner: string, name: string, revision: string, signal: AbortSignal): Promise<string | null>
    validateToolNames(owner: string, names: string[], signal: AbortSignal): Promise<void>
    account?: (ref: DesktopMcpSseRef, action: 'read' | 'use' | 'call' | 'close', run: McpRunIdentity | undefined, signal: AbortSignal) => Promise<{ server: RemoteServer & { id: string; transport: 'sse' }; bearer: string; credentialGeneration: string; check(): void } | null>
    network?: SseNetwork
}

function invocationId(owner: string, ref: DesktopMcpSseRef, run: McpRunIdentity, callId: string) {
    const bytes = createHash('sha256').update(JSON.stringify(['desktop-sse-call-v1', owner, ref.serverId, run, callId])).digest().subarray(0, 16)
    bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128
    const hex = bytes.toString('hex')
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}

export function createDesktopSseBinding(deps: DesktopSseBindingDeps) {
    const credentials = new WeakMap<object, { ref: DesktopMcpSseRef; bearer: string }>()
    const fingerprint = (ref: DesktopMcpSseRef, bearer: string) => createHmac('sha256', deps.key()).update(JSON.stringify([ref, bearer])).digest('hex')
    async function credential(ref: DesktopMcpSseRef, signal: AbortSignal) {
        signal.throwIfAborted()
        const account = await deps.account?.(ref, 'use', undefined, signal)
        if (account) return account
        const server = await deps.store.read(ref.agentId, ref.name)
        if (server.id !== ref.serverId || server.revision !== ref.expectedRevision || server.transport !== 'sse') throw new SseFailure('changed')
        const oauth = await deps.store.readOAuth(ref.agentId, ref.name)
        if (oauth && (oauth.refreshPending || oauth.resource !== server.url || oauth.expiresAt <= Date.now())) throw new SseFailure('auth-needed')
        signal.throwIfAborted()
        return { server, bearer: oauth?.accessToken ?? server.bearer }
    }
    async function preflight(ref: DesktopMcpSseRef, signal: AbortSignal) {
        if (await deps.account?.(ref, 'use', undefined, signal)) return
        const permission = await deps.access(ref.agentId)
        if (!permission.enabled || !permission.granted) throw new SseFailure('changed')
        const current = await credential(ref, signal).catch(async error => {
            if (!(error instanceof SseFailure) || error.code !== 'auth-needed') throw error
            return { server: await deps.store.read(ref.agentId, ref.name), bearer: '' }
        })
        if (current.server.id !== ref.serverId || current.server.transport !== 'sse' || current.server.revision !== ref.expectedRevision) throw new SseFailure('changed')
        // Refresh before any SSE lifecycle admission, so a credential mutation cannot wait on its own stream.
        const token = await deps.store.readOAuth(ref.agentId, ref.name)
        if (token && token.expiresAt <= Date.now() + 60_000) await runtime.dispose(ref.agentId, ref.serverId)
        await deps.refreshCredential(ref.agentId, ref.name, ref.expectedRevision, signal)
        await credential(ref, signal)
    }
    const network = deps.network ?? createPinnedSseNetwork({
        resolvePublic: publicOAuthAddress,
        async credential(authority, signal) {
            authority.check()
            const saved = credentials.get(authority.credentialHandle as object)
            if (!saved) throw new SseFailure('changed')
            const current = await credential(saved.ref, signal)
            authority.check()
            if (('credentialGeneration' in current ? current.credentialGeneration : fingerprint(saved.ref, current.bearer)) !== authority.credentialGeneration || current.server.url !== authority.server.url) throw new SseFailure('changed')
            return current.bearer ? { bearer: current.bearer } : {}
        },
    })
    const runtime = createSseRuntime({
        lifecycle: deps.store.lifecycle,
        ledger: sqliteSseCallLedger(deps.db),
        shutdownSignal: deps.shutdownSignal,
        network,
        async authorize({ ref, action, run }, signal): Promise<SseAuthority> {
            const account = await deps.account?.(ref, action, run, signal)
            if (account) {
                const handle = {}, check = () => { account.check(); deps.shutdownSignal.throwIfAborted() }
                check(); credentials.set(handle, { ref, bearer: account.bearer })
                return { server: account.server, credentialGeneration: account.credentialGeneration, credentialHandle: handle, check }
            }
            const watch = deps.store.lifecycle.watch(ref.agentId, ref.name)
            const permission = await deps.access(ref.agentId)
            if (action === 'use' || action === 'call') {
                if (!permission.enabled || !permission.granted) throw new SseFailure('changed')
                if (action === 'call' && (!run || await deps.authorizeRun(run, signal) !== ref.agentId)) throw new SseFailure('changed')
            }
            const { server, bearer } = action === 'close' ? { server: await deps.store.read(ref.agentId, ref.name), bearer: '' } : await credential(ref, signal)
            if (server.id !== ref.serverId || server.transport !== 'sse' || server.revision !== ref.expectedRevision) throw new SseFailure('changed')
            signal.throwIfAborted()
            const handle = {}, check = () => { watch(); deps.shutdownSignal.throwIfAborted() }
            check()
            credentials.set(handle, { ref, bearer })
            return { server: { ...server, id: ref.serverId, transport: 'sse', hasBearer: !!bearer }, credentialGeneration: fingerprint(ref, bearer), credentialHandle: handle, check }
        },
        protect(value, authority) {
            const bearer = credentials.get(authority.credentialHandle as object)?.bearer
            const secrets = bearer ? [bearer, encodeURIComponent(bearer), Buffer.from(bearer).toString('base64')] : []
            function redact(item: unknown): unknown {
                if (typeof item === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), item)
                if (Array.isArray(item)) return item.map(redact)
                if (item && typeof item === 'object') {
                    const output: Record<string, unknown> = Object.create(null)
                    for (const [key, child] of Object.entries(item)) {
                        const clean = String(redact(key))
                        if (Object.hasOwn(output, clean)) throw new SseFailure('invalid-data')
                        output[clean] = redact(child)
                    }
                    return output
                }
                return item
            }
            return redact(value)
        },
        normalizeTool(tool) {
            const { schema, note } = toToolInputSchema(tool.inputSchema)
            const description = note ? `${tool.description ?? tool.name}\n\n${note}` : tool.description
            if (description && description.length > 8000) throw new SseFailure('invalid-data')
            return { name: tool.name, inputSchema: schema, ...(description !== undefined ? { description } : {}) }
        },
    }, createSsePoolState())
    const control = sseControlAdapter(runtime)
    const settings = createSseSettings(deps.db, deps.store, deps.manage, runtime.dispose)
    return {
        runtime, settings,
        async control(input: DesktopMcpSseRequest, signal: AbortSignal) {
            if (input.operation === 'connect' || input.operation === 'probe') await preflight(input, signal)
            return control(input, signal)
        },
        async tools(owner: string, run: McpRunIdentity, signal: AbortSignal) {
            if (await deps.authorizeRun(run, signal) !== owner) throw new SseFailure('changed')
            const definitions = []
            for (const server of (await deps.store.list(owner)).filter(row => row.transport === 'sse')) {
                if (!server.id) throw new SseFailure('changed')
                const ref: DesktopMcpSseRef = { agentId: owner, serverId: server.id, name: server.name, expectedRevision: server.revision }
                await preflight(ref, signal)
                for (const tool of await sseToolDefinitions(runtime, ref, run, signal)) definitions.push({
                    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
                    execute: (args: Record<string, unknown>, stop: AbortSignal, toolCallId: string) => tool.execute(args, { requestId: invocationId(owner, ref, run, toolCallId), toolCallId }, stop),
                })
            }
            await deps.validateToolNames(owner, definitions.map(tool => tool.name), signal)
            return definitions
        },
        releaseRun: runtime.releaseRun,
        releaseServerRun: runtime.releaseServerRun,
        dispose: runtime.dispose,
        shutdown: runtime.shutdown,
    }
}
