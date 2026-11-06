import 'server-only'
import { z } from 'zod'
import { desktopScheduleToolNoticeSchema } from '@rerun/contracts'
import { getAgent } from '@/lib/engine/client'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { engineOf, readDesktopProviders } from '../settings'
import { findDesktopAgent } from '../store'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { assertDesktopSetupChatAllowed } from '../setup/service'
import { resolveDesktopChatModel } from '../chat-model'
import { boundedText } from '../mcp/remote'
import { acceptDesktopScheduleToolNotice, bindDesktopScheduleToolNotices } from './notices'
const requestSchema = z.discriminatedUnion('op', [z.strictObject({ op: z.literal('owner'), launchNonce: z.string(), engineAgentId: z.string().min(1).max(200) }), z.strictObject({ op: z.literal('notice'), launchNonce: z.string(), notice: desktopScheduleToolNoticeSchema })])
export async function handleDesktopScheduleToolBridge(request: Request) {
 try {
  const runtime = await authenticateDesktopEngineRequest(request), signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)])
  const input = requestSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 16000)))
  if (input.launchNonce !== runtime.launchNonce) throw new DesktopHttpError(409, 'Routine runtime changed')
  const id = input.op === 'owner' ? input.engineAgentId : input.notice.engineAgentId
  const db = await openDesktopDatabase(runtime.dataRoot)
  const rows = (await db.execute({ sql: 'SELECT id FROM desktop_agents WHERE engine_agent_id=? AND workspace_id=1', args: [id] })).rows
  if (rows.length !== 1) throw new DesktopHttpError(404, 'Coworker not found')
  const owner = await findDesktopAgent(db, String(rows[0]!.id)); if (!owner || owner.engineAgentId !== id) throw new DesktopHttpError(409, 'Coworker changed')
  await assertCoworkerNotDeleting(db, owner.id)
  if (input.op === 'notice') {
   if (input.notice.localAgentId !== owner.id) throw new DesktopHttpError(409, 'Routine owner changed')
   bindDesktopScheduleToolNotices(); acceptDesktopScheduleToolNotice(input.notice, `${runtime.dataRoot}\0${runtime.launchNonce}`)
   return Response.json({ ok: true })
  }
  const detail = await getAgent(engineOf(runtime), id)
  if (detail.id !== id) throw new DesktopHttpError(409, 'Coworker changed')
  let setupPending = false
  try { await assertDesktopSetupChatAllowed(runtime, owner.id) } catch { setupPending = true }
  let connectedModel: { provider: string; model: string } | null = null
  try {
   const selected = await resolveDesktopChatModel(runtime, owner, null), providers = await readDesktopProviders(runtime)
   const connection = providers.connections.find(row => row.id === selected.connectionId && row.connected)
   if (connection) connectedModel = { provider: connection.provider, model: selected.model }
  } catch { /* Disabled/absent models cannot authorize an enabled routine. */ }
  await assertCoworkerNotDeleting(db, owner.id); signal.throwIfAborted()
  const final = await findDesktopAgent(db, owner.id)
  if (!final || final.engineAgentId !== id) throw new DesktopHttpError(409, 'Coworker changed')
  return Response.json({ owner: { localAgentId: owner.id, engineAgentId: id, enabled: final.enabled && detail.config.enabled, deleting: false, setupPending, scheduleManage: (detail.config.tools.desktopToolGrants as Record<string, boolean> | undefined)?.scheduleManage === true, connectedModel } })
 } catch { return Response.json({ error: 'Routine authority is unavailable for this coworker.' }, { status: 409 }) }
}
