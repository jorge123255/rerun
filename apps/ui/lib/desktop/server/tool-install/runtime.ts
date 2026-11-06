import 'server-only'
import { z } from 'zod'
import { createDesktopToolInstallService, desktopToolInstallGuestIdentitySchema, desktopToolInstallGuestResultSchema, desktopToolInstallInputSchema, desktopToolInstallSnapshotSchema, type DesktopToolInstallOperation, type DesktopToolInstallPorts, type DesktopToolInstallRunIdentity } from '@rerun/contracts'
import { openDesktopDatabase } from '../database'
import { authenticateDesktopEngineRequest, authenticateDesktopRequest, DesktopHttpError } from '../auth'
import { readDesktopRuntime, type DesktopRuntime } from '../runtime'
import { findDesktopAgent, findDesktopSession } from '../store'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { assertDesktopSetupChatAllowed } from '../setup/service'
import { boundedText } from '../mcp/remote'
import { desktopToolInstallStore } from './store'
import { createDesktopToolInstallServer } from './service'
import { desktopToolInstallHttp } from './http'

const sourceSchema = z.strictObject({ engineAgentId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), runId: z.string().min(1).max(200), toolCallId: z.string().min(1).max(200) })
const proposalSchema = z.strictObject({ launchNonce: z.string().min(1), source: sourceSchema, packages: desktopToolInstallInputSchema.shape.packages })
type Base = Omit<DesktopToolInstallRunIdentity, 'guest'>
const key = (runtime: DesktopRuntime) => JSON.stringify(runtime)
export async function createDesktopToolInstallRuntime(runtime: DesktopRuntime) {
 const db = await openDesktopDatabase(runtime.dataRoot), outcomes = desktopToolInstallStore(db)
 async function target(base: Base, signal: AbortSignal) {
  signal.throwIfAborted()
  if (key(await readDesktopRuntime()) !== key(runtime)) throw new Error('Installation runtime changed')
  const agent = await findDesktopAgent(db, base.agentId), session = await findDesktopSession(db, base.sessionId)
  if (!agent || !agent.enabled || !session || session.agentId !== agent.id) throw new Error('Installation conversation changed')
  await assertCoworkerNotDeleting(db, agent.id)
  await assertDesktopSetupChatAllowed(runtime, agent.id)
  signal.throwIfAborted()
  return { engineAgentId: agent.engineAgentId, sessionId: session.engineSessionId, runId: base.runId, toolCallId: base.toolCallId }
 }
 async function rpc(body: unknown, signal: AbortSignal) {
  signal.throwIfAborted()
  const response = await fetch(`${runtime.engine.origin}/desktop/tool-install/control`, { method: 'POST', redirect: 'error', cache: 'no-store', signal, headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ launchNonce: runtime.launchNonce, ...body as object }) })
  const raw = JSON.parse(await boundedText(response, signal, 128000))
  if (!response.ok) throw new Error('The isolated installation could not be confirmed.')
  return raw
 }
 async function guest(op: DesktopToolInstallOperation, signal: AbortSignal, mode: 'install' | 'inspect') {
  const source = await target(op.identity, signal)
  if (source.engineAgentId !== op.identity.guest.engineAgentId) throw new Error('Installation coworker changed')
  const body = { mode, source, identity: op.identity, operationId: op.operationId, packages: op.packages }
  // Keep the request alive while an independent cancel RPC waits for the engine/guest drain.
  let cancellation: Promise<unknown> | undefined
  const cancel = () => { cancellation ??= rpc({ mode: 'cancel', source, operationId: op.operationId }, AbortSignal.timeout(40000)); void cancellation.catch(() => {}) }
  signal.throwIfAborted(); signal.addEventListener('abort', cancel, { once: true })
  try {
   const raw = await rpc(body, AbortSignal.timeout(330000))
   if (signal.aborted) { cancel(); await cancellation; throw new Error('Installation stopped; inspect its saved result.') }
   return desktopToolInstallGuestResultSchema.parse(raw.result)
  } finally { signal.removeEventListener('abort', cancel); if (cancellation) await cancellation }
 }
 const ports: DesktopToolInstallPorts = {
  outcomes,
  authority: async (base, signal, phase) => {
   const source = await target(base, signal)
   const raw = await rpc({ mode: 'authority', source, phase: phase ?? 'review' }, signal)
   const result = desktopToolInstallGuestIdentitySchema.parse(raw.guest)
   if (result.engineAgentId !== source.engineAgentId || result.launchNonce !== runtime.launchNonce) throw new Error('Installation guest changed')
   await target(base, signal)
   return result
  },
  guest: { execute: (op, signal) => guest(op, signal, 'install'), inspect: (op, signal) => guest(op, signal, 'inspect') },
 }
 return { db, ports, service: createDesktopToolInstallService(ports) }
}
export async function handleDesktopToolInstall(request: Request, sessionId: string) {
 try {
  const runtime = await authenticateDesktopRequest(request), bound = await createDesktopToolInstallRuntime(runtime)
  return desktopToolInstallHttp(runtime, bound.ports)(request, sessionId)
 } catch { return Response.json({ error: 'Tool installation is unavailable for this conversation.' }, { status: 409 }) }
}
export async function handleDesktopToolInstallProposal(request: Request) {
 try {
  const runtime = await authenticateDesktopEngineRequest(request), signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)])
  const input = proposalSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 32768)))
  if (input.launchNonce !== runtime.launchNonce) throw new DesktopHttpError(409, 'Installation runtime changed')
  const bound = await createDesktopToolInstallRuntime(runtime)
  const rows = (await bound.db.execute({ sql: `SELECT a.id agent_id,s.id session_id FROM desktop_agents a JOIN desktop_sessions s ON s.agent_id=a.id WHERE a.workspace_id=1 AND a.engine_agent_id=? AND s.engine_session_id=?`, args: [input.source.engineAgentId, input.source.sessionId] })).rows
  if (rows.length !== 1) throw new DesktopHttpError(409, 'Installation conversation unavailable')
  const base = { agentId: String(rows[0]!.agent_id), sessionId: String(rows[0]!.session_id), runId: input.source.runId, toolCallId: input.source.toolCallId, proposalRevision: '1' }
  const installation = desktopToolInstallSnapshotSchema.parse(await bound.service.propose(base, { packages: input.packages }, signal))
  return Response.json({ installation }, { headers: { 'cache-control': 'no-store' } })
 } catch { return Response.json({ error: 'The reviewed installation proposal could not be saved.' }, { status: 409 }) }
}

/** Passive ledger projection only: no guest admission, probe, inspect or execution. */
export async function readDesktopToolInstallHistory(runtime: DesktopRuntime, sessionId: string, options?: { signal?: AbortSignal }) {
 options?.signal?.throwIfAborted()
 const bound = await createDesktopToolInstallRuntime(runtime)
 const result = await createDesktopToolInstallServer(runtime, bound.ports).history(sessionId)
 options?.signal?.throwIfAborted()
 return result
}
