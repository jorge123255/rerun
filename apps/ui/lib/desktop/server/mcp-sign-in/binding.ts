import 'server-only'
import { desktopMcpSignInBridgeSchema, desktopMcpSignInServerSchema, desktopMcpSignInSourceResponseSchema, type DesktopMcpSignInSource } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { chat, request as engineRequest } from '@/lib/engine/client'
import { engineAgentDetailSchema } from '@/lib/engine/types'
import { openDesktopDatabase } from '../database'
import { findDesktopAgent, findDesktopSession } from '../store'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { readDesktopRuntime, type DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { resolveDesktopChatModel } from '../chat-model'
import { getDesktopRemoteMcpService, watchDesktopMcpOwner } from '../mcp-binding'
import { watchDesktopSecretAuthority } from '../secret-requests/lifecycle'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'
import { boundedText } from '../mcp/remote'
import { createDesktopMcpSignInStore } from './store'
import { createDesktopMcpSignInRuntimePorts, type DesktopMcpSignInOAuthTarget } from './runtime'

const stateKey = Symbol.for('rerun.desktop.mcp-sign-in-oauth-attempts.v1')
type OAuthOwner = { requestId: string; attemptId: string }
type State = { owners: Map<string, OAuthOwner>; tails: Map<string, Promise<unknown>> }
const states = () => ((globalThis as unknown as Record<symbol, Map<string, State>>)[stateKey] ??= new Map())
function state(runtime: DesktopRuntime) { const key = JSON.stringify([runtime.dataRoot, runtime.launchNonce]); let value = states().get(key); if (!value) { value = { owners: new Map(), tails: new Map() }; states().set(key, value) }; return value }
function exclusive<T>(state: State, key: string, work: () => Promise<T>): Promise<T> { const next = (state.tails.get(key) ?? Promise.resolve()).then(work, work); state.tails.set(key, next.then(() => undefined, () => undefined)); return next }
const guardOf = ({ runId, sourceMessageId, toolCallId, fingerprint, server }: DesktopMcpSignInSource) => ({ runId, sourceMessageId, toolCallId, fingerprint, server })
const sameSource = (a: DesktopMcpSignInSource, b: DesktopMcpSignInSource) => JSON.stringify(guardOf(a)) === JSON.stringify(guardOf(b)) && a.agentId === b.agentId && a.sessionId === b.sessionId

export async function desktopMcpSignInPorts(runtime: DesktopRuntime, sessionId: string) {
    const db = await openDesktopDatabase(runtime.dataRoot), session = await findDesktopSession(db, sessionId)
    if (!session) throw new DesktopHttpError(404, 'Conversation not found.')
    const agent = await findDesktopAgent(db, session.agentId)
    if (!agent || agent.workspaceId !== 1) throw new DesktopHttpError(404, 'Coworker not found.')
    const store = createDesktopMcpSignInStore(db), service = await getDesktopRemoteMcpService(runtime), attempts = state(runtime)
    const initialOwner = watchDesktopMcpOwner(runtime, agent.id), initialSession = watchDesktopSecretAuthority(runtime, agent.id, session.id)
    const check = (signal: AbortSignal) => { signal.throwIfAborted(); service.shutdownSignal.throwIfAborted(); initialOwner(); initialSession() }
    async function owner(signal: AbortSignal) {
        check(signal)
        const now = await readDesktopRuntime()
        if (now.launchNonce !== runtime.launchNonce || now.dataRoot !== runtime.dataRoot || now.engine.origin !== runtime.engine.origin || now.app.origin !== runtime.app.origin) throw new DesktopHttpError(409, 'Rerun restarted. Reload this sign-in request.')
        await assertCoworkerNotDeleting(db, agent!.id)
        const [currentSession, currentAgent] = await Promise.all([findDesktopSession(db, session!.id), findDesktopAgent(db, agent!.id)])
        const aliases = await db.execute({ sql: 'SELECT id FROM desktop_sessions WHERE engine_session_id=?', args: [session!.engineSessionId] })
        if (!currentSession || !currentAgent || currentSession.agentId !== agent!.id || currentSession.engineSessionId !== session!.engineSessionId || currentAgent.workspaceId !== 1 || currentAgent.engineAgentId !== agent!.engineAgentId || aliases.rows.length !== 1 || String(aliases.rows[0].id) !== session!.id) throw new DesktopHttpError(409, 'MCP sign-in ownership changed.')
        check(signal)
    }
    async function readSource(signal: AbortSignal, expected?: DesktopMcpSignInSource) {
        await owner(signal)
        const response = await engineRequest(engineOf(runtime), `/agents/${encodeURIComponent(agent!.engineAgentId)}/sessions/${encodeURIComponent(session!.engineSessionId)}/mcp-sign-in-source`, { method: 'POST', signal, body: JSON.stringify(expected ? { source: guardOf(expected) } : {}) }, value => desktopMcpSignInSourceResponseSchema.parse(value))
        await owner(signal)
        if (response.agentId !== agent!.engineAgentId || response.sessionId !== session!.engineSessionId) throw new DesktopHttpError(409, 'MCP sign-in source belongs to another conversation.')
        return response.request ? { ...response.request.input, source: { agentId: agent!.id, sessionId: session!.id, ...response.request.guard }, status: response.request.status } : null
    }
    async function registration(source: DesktopMcpSignInSource, signal: AbortSignal) {
        await owner(signal)
        const row = await service.store.read(agent!.id, source.server.name)
        if (row.transport !== 'http' || row.bearer || row.name !== source.server.name || row.revision !== source.server.revision || row.url !== source.server.url) throw new DesktopHttpError(409, 'This MCP registration changed or does not support sign-in.')
        check(signal); return row
    }
    async function authority(source: DesktopMcpSignInSource, signal: AbortSignal, mode: 'decision' | 'replay' | 'read' | 'dismiss' = 'decision') {
        if (source.agentId !== agent!.id || source.sessionId !== session!.id) throw new DesktopHttpError(409, 'MCP sign-in belongs to another conversation.')
        const saved = await readSource(signal, mode === 'decision' || mode === 'dismiss' ? undefined : source)
        if (!saved || !sameSource(saved.source, source) || saved.status !== 'done') throw new DesktopHttpError(409, 'This MCP sign-in was stopped or its source changed.')
        const detail = await engineRequest(engineOf(runtime), `/agents/${encodeURIComponent(agent!.engineAgentId)}`, { method: 'GET', signal }, value => engineAgentDetailSchema.parse(value))
        if (detail.id !== agent!.engineAgentId || detail.config.ephemeral) throw new DesktopHttpError(409, 'MCP sign-in ownership changed.')
        if (mode === 'decision') {
            if (!detail.config.enabled || detail.config.tools.desktopToolGrants?.mcp !== true) throw new DesktopHttpError(409, 'MCP permission is unavailable.')
            await registration(source, signal)
        }
        await owner(signal)
        return { check: () => check(signal) }
    }
    const slot = (target: DesktopMcpSignInOAuthTarget) => JSON.stringify([agent!.id, target.source.server.name])
    const exact = (target: DesktopMcpSignInOAuthTarget) => { const current = attempts.owners.get(slot(target)); return !!current && current.requestId === target.requestId && current.attemptId === target.attemptId }
    return createDesktopMcpSignInRuntimePorts({ store, authority,
        source: async (id, signal) => {
            if (id !== session!.id) throw new DesktopHttpError(409, 'MCP sign-in conversation changed.')
            const pending = await readSource(signal)
            if (pending) return pending.status === 'done' ? pending : null
            const saved = await store.latestUnaccepted(agent!.id, session!.id)
            return saved ? await readSource(signal, saved.source) : null
        },
        oauth: {
            async start(target, signal) {
                return exclusive(attempts, slot(target), async () => {
                    const current = await authority(target.source, signal)
                    const request = await store.read(target.requestId)
                    if (!target.attemptId || request?.activeAttemptId !== target.attemptId || !sameSource(request.source, target.source)) throw new DesktopHttpError(409, 'MCP sign-in attempt changed.')
                    attempts.owners.set(slot(target), { requestId: target.requestId, attemptId: target.attemptId })
                    const result = await service.oauth.start(agent!.id, target.source.server.name, target.source.server.revision, signal)
                    current.check()
                    return { ...result.status, ...(result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}) }
                })
            },
            async status(target, signal) {
                try { await registration(target.source, signal); return await service.oauth.status(agent!.id, target.source.server.name, target.source.server.revision, signal) }
                catch { await owner(signal); return { state: 'unsupported', message: 'This server or its permission changed. Choose Not now, or restore its configuration before signing in.' } }
            },
            async cancel(target, signal) {
                return exclusive(attempts, slot(target), async () => {
                    await owner(signal)
                    if (!exact(target)) return
                    // A removed/reconfigured registration already invalidated its old callback.
                    const row = (await service.store.list(agent!.id)).find(item => item.name === target.source.server.name)
                    await owner(signal)
                    if (!row || row.revision !== target.source.server.revision || row.url !== target.source.server.url) { attempts.owners.delete(slot(target)); return }
                    const detail = await engineRequest(engineOf(runtime), `/agents/${encodeURIComponent(agent!.engineAgentId)}`, { method: 'GET', signal }, value => engineAgentDetailSchema.parse(value))
                    await owner(signal)
                    if (detail.id !== agent!.engineAgentId) throw new DesktopHttpError(409, 'MCP sign-in ownership changed.')
                    // Coworker disable/revoke already closes the owner's callback through the canonical lifecycle.
                    if (!detail.config.enabled || detail.config.tools.desktopToolGrants?.mcp !== true) { attempts.owners.delete(slot(target)); return }
                    await service.oauth.cancel(agent!.id, target.source.server.name, target.source.server.revision, signal)
                    if (exact(target)) attempts.owners.delete(slot(target))
                })
            },
            async ready(target, signal) {
                await authority(target.source, signal)
                const result = await service.runtime.probe(agent!.id, target.source.server.name, target.source.server.revision, signal)
                if (!Array.isArray(result.tools)) throw new DesktopHttpError(409, 'MCP tools are not ready.')
                await authority(target.source, signal)
            },
        },
        send: async (receipt, source, mode) => {
            await authority(source, AbortSignal.timeout(20_000), mode === 'replay' ? 'replay' : receipt.outcome === 'declined' ? 'dismiss' : 'decision')
            const model = mode === 'send' ? await resolveDesktopChatModel(runtime, agent!, session!) : undefined
            const queued = { runId: receipt.continuationRequestId, mcpSignIn: guardOf(source), ...(mode === 'replay' ? { replayOnly: true } : {}) }
            const response = await chat(engineOf(runtime), agent!.engineAgentId, { sessionId: session!.engineSessionId, message: receipt.summary, source: 'dashboard', ...(model ? { connectionId: model.connectionId, model: model.model } : {}), author: { id: 'local-profile-1', name: 'Local User' }, desktopQueuedTurn: queued })
            const failure = response.ok ? null : await response.clone().json().catch(() => null) as { code?: string } | null
            const actualSession = response.headers.get('x-session-id')
            return { status: response.status, code: failure?.code, sessionId: actualSession === session!.engineSessionId ? session!.id : actualSession, runId: response.headers.get('x-run-id'), contentType: response.headers.get('content-type'), body: response.ok ? response.body : null }
        },
    })
}


/** Passive pending projection: no OAuth token status, authorization, or connection probe. */
export async function readDesktopMcpSignInView(runtime: DesktopRuntime, sessionId: string, options?: { signal?: AbortSignal }) {
    const signal = options?.signal ?? AbortSignal.timeout(20_000)
    const result = await (await desktopMcpSignInPorts(runtime, sessionId)).read(sessionId, signal, { metadataOnly: true })
    return result.request?.receipt?.accepted ? { request: null } : result
}

export async function handleDesktopMcpSignInBridge(request: Request): Promise<Response> {
    const runtime = await authenticateDesktopEngineRequest(request), signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
    const body = desktopMcpSignInBridgeSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 8192)))
    const service = await getDesktopRemoteMcpService(runtime), owner = await service.authorizeRun(body.identity, signal, 'mcp')
    const check = watchDesktopMcpOwner(runtime, owner), serverCheck = service.store.lifecycle.watch(owner, body.input.name), row = await service.store.read(owner, body.input.name)
    if (row.transport !== 'http' || row.bearer) throw new DesktopHttpError(409, 'Only registered HTTP OAuth servers support this sign-in request.')
    await service.authorizeRun(body.identity, signal, 'mcp'); check(); serverCheck(); signal.throwIfAborted()
    return Response.json(desktopMcpSignInServerSchema.parse({ name: row.name, revision: row.revision, url: row.url, displayName: row.name, host: new URL(row.url).hostname }), { headers: { 'cache-control': 'no-store' } })
}
