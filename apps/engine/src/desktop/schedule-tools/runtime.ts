import { z } from 'zod'
import { getRun } from '../../db/repos/runs.js'
import { getSystemDb } from '../../db/systemDb.js'
import { listAgentIdsOnDisk } from '../../agents/loader.js'
import { desktopDeletionActive } from '../agent-lifecycle.js'
import { bindDesktopScheduleTools } from './binding.js'
const ownerSchema = z.strictObject({ localAgentId: z.string(), engineAgentId: z.string(), enabled: z.boolean(), deleting: z.boolean(), setupPending: z.boolean(), scheduleManage: z.boolean(), connectedModel: z.object({ provider: z.string(), model: z.string() }).nullable() })
export async function createDesktopScheduleToolRuntime(runtime: { launchNonce: string; app: { origin: string }; engine: { apiKey: string } }) {
 const closing = new AbortController(), pending = new Set<Promise<unknown>>()
 async function callback(input: object) {
  const signal = AbortSignal.any([closing.signal, AbortSignal.timeout(10000)]); signal.throwIfAborted()
  const response = await fetch(`${runtime.app.origin}/api/desktop/internal/schedule-tools`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, launchNonce: runtime.launchNonce }), signal })
  const reader = response.body?.getReader(); if (!reader) throw new Error('Routine authority unavailable')
  const chunks: Uint8Array[] = []; let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }; signal.addEventListener('abort', cancel, { once: true })
  try { while (true) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break; size += part.value.length; if (size > 16000) throw new Error('Routine authority response too large'); chunks.push(part.value) } if (!response.ok) throw new Error('Routine authority refused'); return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}) }
 }
 const binding = bindDesktopScheduleTools({ getSystemClient: async id => (await getSystemDb(id)).client, authority: {
  assertActive: () => closing.signal.throwIfAborted(),
  resolveOwner: async id => {
   if (desktopDeletionActive(id)) throw new Error('Coworker is being deleted')
   const result = ownerSchema.parse((await callback({ op: 'owner', engineAgentId: id })).owner)
   if (result.engineAgentId !== id) throw new Error('Routine owner changed')
   return result
  },
  readRun: async (agent, run) => (await getRun(agent, run)) ?? null,
  notify: async notice => { await callback({ op: 'notice', notice }) },
 } })
 const rawTools = binding.tools
 binding.tools = (id, context) => {
  const tools = rawTools(id, { ...context, abortSignal: AbortSignal.any([closing.signal, ...(context?.abortSignal ? [context.abortSignal] : [])]) })
  for (const value of Object.values(tools)) {
   const execute = value.execute
   if (!execute) continue
   value.execute = ((...args: Parameters<typeof execute>) => {
    const result = Promise.resolve(execute(...args)); pending.add(result)
    return result.finally(() => pending.delete(result))
   }) as typeof execute
  }
  return tools
 }
 for (const id of await listAgentIdsOnDisk()) if (!desktopDeletionActive(id)) await binding.recover(id)
 return { ...binding, async close() { closing.abort(); await Promise.allSettled([...pending]) } }
}
