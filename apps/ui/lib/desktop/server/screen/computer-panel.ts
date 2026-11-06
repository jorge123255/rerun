import 'server-only'
import { z } from 'zod'
import { request as engineRequest } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { findDesktopAgent, findDesktopSession } from '../store'
import { engineOf } from '../settings'
import type { DesktopRuntime } from '../runtime'
import { readDesktopTakeover } from '../takeover'
import { computerPanelEngineFactsSchema, computerPanelLaunchSchema, computerPanelOutcomeSchema } from '../../computer-panel/contract'
async function binding(runtime: DesktopRuntime, agentId: string, sessionId: string) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const [agent, session] = await Promise.all([findDesktopAgent(db, agentId), findDesktopSession(db, sessionId)])
    if (!agent || !session || session.agentId !== agent.id) throw new DesktopHttpError(404, 'Conversation not found')
    return { source: { agentId: agent.engineAgentId, sessionId: session.engineSessionId }, agent, session }
}
async function same(runtime: DesktopRuntime, agentId: string, sessionId: string, source: { agentId: string; sessionId: string }) {
    const fresh = await binding(runtime, agentId, sessionId)
    if (fresh.source.agentId !== source.agentId || fresh.source.sessionId !== source.sessionId) throw new DesktopHttpError(409, 'Conversation changed')
}
export async function readDesktopComputerPanel(runtime: DesktopRuntime, agentId: string, sessionId: string, signal: AbortSignal) {
    const { source } = await binding(runtime, agentId, sessionId)
    const facts = await engineRequest(engineOf(runtime), '/desktop/computer-panel/control', { method: 'POST', body: JSON.stringify({ action: 'read', launchNonce: runtime.launchNonce, source }), signal }, value => computerPanelEngineFactsSchema.parse(value))
    const takeover = (await readDesktopTakeover(runtime, sessionId, { signal })).takeover
    await same(runtime, agentId, sessionId, source); signal.throwIfAborted()
    if (facts.current && facts.current.sessionId !== source.sessionId) throw new DesktopHttpError(409, 'Computer owner changed')
    return { ...facts, workspaceId: String(runtime.workspaceId), current: facts.current ? { agentId, sessionId, runId: facts.current.runId, liveScreen: { kind: facts.current.kind, site: facts.current.site } } : null,
        takeover: takeover ? { takeoverId: takeover.id, reason: takeover.reason, url: takeover.url ?? '', opened: false } : null }
}
export async function launchDesktopComputerApp(runtime: DesktopRuntime, agentId: string, sessionId: string, input: z.infer<typeof computerPanelLaunchSchema>, signal: AbortSignal) {
    const { source } = await binding(runtime, agentId, sessionId)
    const result = await engineRequest(engineOf(runtime), '/desktop/computer-panel/control', { method: 'POST', body: JSON.stringify({ action: 'launch', launchNonce: runtime.launchNonce, source, ...input }), signal }, value => computerPanelOutcomeSchema.parse(value))
    await same(runtime, agentId, sessionId, source); signal.throwIfAborted()
    if (result.requestId !== input.requestId || result.app !== input.app) throw new DesktopHttpError(409, 'Launcher acknowledgement changed')
    return result
}
