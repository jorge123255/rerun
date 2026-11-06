import 'server-only'
import type { DesktopRuntime } from '../runtime'
import { DesktopHttpError } from '../auth'
import type { DesktopSecretRequestApiPorts } from './api'
import { desktopRerunGrantsOf, desktopSecretSourceResponseSchema, sameDesktopSecretRequestSource, type DesktopSecretRequestSource } from '@rerun/contracts'
import { chat, request as engineRequest } from '@/lib/engine/client'
import { engineAgentDetailSchema } from '@/lib/engine/types'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { openDesktopDatabase } from '../database'
import { readDesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { resolveDesktopChatModel } from '../chat-model'
import { findDesktopAgent, findDesktopSession } from '../store'
import { createDesktopSecretCrypto } from './crypto'
import { createDesktopSecretRequestStore } from './store'
import { createDesktopSecretRequestRuntimePorts } from './runtime'
import { watchDesktopSecretAuthority } from './lifecycle'
let opener: ((runtime: DesktopRuntime, sessionId: string) => DesktopSecretRequestApiPorts) | undefined
export function bindDesktopSecretRequestPorts(next: NonNullable<typeof opener>) {
    if (opener) throw new Error('Credential request authority is already bound')
    opener = next
}
export function desktopSecretRequestPorts(runtime: DesktopRuntime, sessionId: string): DesktopSecretRequestApiPorts {
    if (opener) return opener(runtime, sessionId)
    return {
        read: async (id, signal) => (await concretePorts(runtime, sessionId, signal)).read(id, signal),
        decide: async (id, input, signal) => (await concretePorts(runtime, sessionId, signal)).decide(id, input, signal),
        recover: async (id, input, signal) => (await concretePorts(runtime, sessionId, signal)).recover(id, input, signal),
    }
}

function masterKey(): Buffer {
    const value = process.env.RERUN_DESKTOP_SECRET_KEY ?? ''
    if (!/^[a-f0-9]{64}$/.test(value)) throw new DesktopHttpError(503, 'Encrypted credential storage is unavailable.')
    return Buffer.from(value, 'hex')
}

async function concretePorts(runtime: DesktopRuntime, sessionId: string, signal: AbortSignal): Promise<DesktopSecretRequestApiPorts> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const session = await findDesktopSession(db, sessionId)
    if (!session) throw new DesktopHttpError(404, 'Conversation not found')
    const agent = await findDesktopAgent(db, session.agentId)
    if (!agent || agent.workspaceId !== 1) throw new DesktopHttpError(404, 'Coworker not found')
    const guardCurrent = watchDesktopSecretAuthority(runtime, agent.id, session.id)
    const store = createDesktopSecretRequestStore(db, createDesktopSecretCrypto(masterKey))
    async function owner() {
        signal.throwIfAborted()
        const currentRuntime = await readDesktopRuntime()
        if (currentRuntime.launchNonce !== runtime.launchNonce || currentRuntime.engine.origin !== runtime.engine.origin || currentRuntime.app.origin !== runtime.app.origin || currentRuntime.dataRoot !== runtime.dataRoot) throw new DesktopHttpError(409, 'Rerun restarted. Reload this credential request.')
        await assertCoworkerNotDeleting(db, agent!.id)
        const currentSession = await findDesktopSession(db, session!.id), currentAgent = await findDesktopAgent(db, agent!.id)
        if (!currentSession || !currentAgent || currentAgent.workspaceId !== 1 || currentSession.agentId !== agent!.id || currentSession.engineSessionId !== session!.engineSessionId || currentAgent.engineAgentId !== agent!.engineAgentId) throw new DesktopHttpError(409, 'Credential request ownership changed.')
        signal.throwIfAborted()
    }
    const guardOf = (source: DesktopSecretRequestSource) => ({ runId: source.runId, sourceMessageId: source.sourceMessageId, toolCallId: source.toolCallId, fingerprint: source.fingerprint })
    async function readSource(expected?: DesktopSecretRequestSource) {
        await owner()
        const response = await engineRequest(engineOf(runtime), `/agents/${encodeURIComponent(agent!.engineAgentId)}/sessions/${encodeURIComponent(session!.engineSessionId)}/secret-request-source`, {
            method: 'POST', signal, body: JSON.stringify(expected ? { source: guardOf(expected) } : {}),
        }, value => desktopSecretSourceResponseSchema.parse(value))
        await owner()
        if (response.agentId !== agent!.engineAgentId || response.sessionId !== session!.engineSessionId) throw new DesktopHttpError(409, 'Credential source belongs to another conversation.')
        const found = response.request
        return found ? { ...found.input, source: { agentId: agent!.id, sessionId: session!.id, ...found.guard }, status: found.status, requestedAt: found.requestedAt } : null
    }
    const authority = (_id: string, expected: DesktopSecretRequestSource, mode: 'decision' | 'replay') => {
        const assertCurrent = () => { signal.throwIfAborted(); if (mode === 'decision') guardCurrent() }
        return { assertCurrent, check: async () => {
            assertCurrent()
            if (expected.agentId !== agent!.id || expected.sessionId !== session!.id || _id !== session!.id) throw new DesktopHttpError(409, 'Credential request belongs to another coworker.')
            const source = await readSource(mode === 'replay' ? expected : undefined)
            if (!source || !sameDesktopSecretRequestSource(source.source, expected)) throw new DesktopHttpError(409, 'Credential source is no longer available.')
            if (mode === 'decision') {
                const detail = await engineRequest(engineOf(runtime), `/agents/${encodeURIComponent(agent!.engineAgentId)}`, { method: 'GET', signal }, value => engineAgentDetailSchema.parse(value))
                if (detail.id !== agent!.engineAgentId || !detail.config.enabled || detail.config.ephemeral || !desktopRerunGrantsOf(detail.config.tools).requestSecret || source.status !== 'done') throw new DesktopHttpError(409, 'The credential request was stopped or its permission is off.')
            }
            await owner()
            assertCurrent()
        } }
    }
    return createDesktopSecretRequestRuntimePorts({ store, authority,
        source: async id => {
            if (id !== session!.id) throw new DesktopHttpError(409, 'Credential conversation changed.')
            const found = await readSource()
            return found && (found.status === 'done' || found.status === 'running') ? { fields: found.fields, ...(found.reason !== undefined ? { reason: found.reason } : {}), source: found.source, requestedAt: found.requestedAt } : null
        },
        recovery: async id => {
            if (id !== session!.id) throw new DesktopHttpError(409, 'Credential conversation changed.')
            const saved = await store.latestUnaccepted(agent!.id, session!.id)
            if (!saved?.receipt) return null
            await authority(id, saved.source, 'replay').check()
            return saved
        },
        send: async (receipt, source, mode, current) => {
            await current.check()
            let model: { connectionId: string; model: string } | undefined
            if (mode === 'send') {
                const latest = await findDesktopSession(db, session!.id)
                if (!latest || latest.agentId !== agent!.id || latest.engineSessionId !== session!.engineSessionId) throw new DesktopHttpError(409, 'Credential conversation changed.')
                model = await resolveDesktopChatModel(runtime, agent!, latest)
                await authority(session!.id, source, 'decision').check()
            }
            const response = await chat(engineOf(runtime), agent!.engineAgentId, { sessionId: session!.engineSessionId, message: receipt.summary, source: 'dashboard',
                ...(model ? { connectionId: model.connectionId, model: model.model } : {}),
                author: { id: 'local-profile-1', name: 'Local User' }, desktopQueuedTurn: { runId: receipt.continuationRequestId, secret: guardOf(source), ...(mode === 'replay' ? { replayOnly: true } : {}) } })
            const failure = response.ok ? null : await response.clone().json().catch(() => null) as { code?: string } | null
            const actualSession = response.headers.get('x-session-id')
            return { status: response.status, code: failure?.code, sessionId: actualSession === session!.engineSessionId ? session!.id : actualSession,
                runId: response.headers.get('x-run-id'), contentType: response.headers.get('content-type'), body: response.ok ? response.body : null }
        },
    })
}

export async function readDesktopSecretRequestView(runtime: DesktopRuntime, sessionId: string, options: { signal?: AbortSignal } = {}) {
    const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])])
    const request = await desktopSecretRequestPorts(runtime, sessionId).read(sessionId, signal)
    return { request: request?.status === 'accepted' ? null : request }
}
