import { Hono } from 'hono'
import { z } from 'zod'
import { tool, type ToolSet } from 'ai'
import { desktopToolInstallInputSchema, desktopToolInstallSnapshotSchema, desktopToolInstallRunIdentitySchema, desktopToolInstallGuestResultSchema, type DesktopToolInstallRunIdentity } from '@rerun/contracts'
import { getRun } from '../../db/repos/runs.js'
import { readAgentConfig } from '../../agents/loader.js'
import { beginDesktopAgentWork, desktopDeletionActive } from '../agent-lifecycle.js'
import { readDesktopSetup } from '../setup/service.js'
import { isolatedScreenOwner, isolatedScreenSignal } from '../isolated-screen/binding.js'
import { service } from '../isolated-screen/index.js'
import type { RunContext } from '../../runtime/context.js'

const sourceSchema = z.strictObject({ engineAgentId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), sessionId: z.string().min(1).max(200), runId: z.string().min(1).max(200), toolCallId: z.string().min(1).max(200) })
const sourceKey = (source: z.infer<typeof sourceSchema>) => JSON.stringify([source.engineAgentId, source.sessionId, source.runId, source.toolCallId])
const requestSchema = z.strictObject({ launchNonce: z.string().min(1), mode: z.enum(['authority', 'install', 'inspect', 'cancel']), source: sourceSchema, phase: z.enum(['propose', 'review', 'inspect']).optional(), identity: desktopToolInstallRunIdentitySchema.optional(), operationId: z.string().regex(/^[a-f0-9]{64}$/).optional(), packages: desktopToolInstallInputSchema.shape.packages.optional() })
type Runtime = { launchNonce: string; app: { origin: string }; engine: { apiKey: string } }
export function bindDesktopToolInstall(runtime: Runtime) {
 const closing = new AbortController(), invocations = new Map<string, AbortSignal>()
 const executing = new Map<string, { source: string; controller: AbortController; target: DesktopToolInstallRunIdentity['guest']; done: Promise<unknown> }>(), cancelled = new Map<string, string>()
 const routes = new Hono()
 async function permission(source: z.infer<typeof sourceSchema>, signal: AbortSignal, proposing = false) {
  signal.throwIfAborted(); closing.signal.throwIfAborted()
  if (desktopDeletionActive(source.engineAgentId)) throw new Error('Coworker is being deleted')
  const config = await readAgentConfig(source.engineAgentId), setup = await readDesktopSetup(source.engineAgentId)
  const grants = config.tools.desktopToolGrants as Record<string, boolean | undefined> | undefined
  if (!config.enabled || !config.selfImprovement.enabled || !config.selfImprovement.allowToolInstall || grants?.toolInstall !== true || setup.pending) throw new Error('Reviewed installation is unavailable for this coworker')
  const run = await getRun(source.engineAgentId, source.runId)
  if (!run || run.agentId !== source.engineAgentId || run.sessionId !== source.sessionId || (proposing ? run.status !== 'running' : !['running', 'done'].includes(run.status))) throw new Error('Installation source is no longer available')
  if (proposing) { const active = invocations.get(sourceKey(source)); if (!active || active.aborted) throw new Error('Installation proposal is not active') }
  signal.throwIfAborted(); closing.signal.throwIfAborted()
 }
 async function bounded(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Installation response missing')
  const chunks: Uint8Array[] = []; let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }; signal.addEventListener('abort', cancel, { once: true })
  try { while (true) { signal.throwIfAborted(); const row = await reader.read(); signal.throwIfAborted(); if (row.done) break; size += row.value.length; if (size > 128000) throw new Error('Installation response too large'); chunks.push(row.value) } return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}) }
 }
 routes.post('/control', async c => {
  try {
   const readSignal = AbortSignal.any([c.req.raw.signal, closing.signal, AbortSignal.timeout(10000)])
   const request = requestSchema.parse(await bounded(new Response(c.req.raw.body), readSignal))
   if (request.launchNonce !== runtime.launchNonce) throw new Error('Installation runtime changed')
   const key = sourceKey(request.source)
   if (request.mode === 'cancel') {
    if (!request.operationId) throw new Error('Installation identity required')
    const active = executing.get(request.operationId)
    if (active && active.source !== key) throw new Error('Installation owner changed')
    if (cancelled.size >= 4096 && !cancelled.has(request.operationId)) throw new Error('Installation cancellation capacity reached')
    const prior = cancelled.get(request.operationId); if (prior && prior !== key) throw new Error('Installation identity changed')
    cancelled.set(request.operationId, key); active?.controller.abort()
    if (active) { await active.done.catch(() => {}); await service().stop(active.target, AbortSignal.timeout(20000)) }
    return c.json({ drained: true })
   }
   const source = request.source, signal = isolatedScreenSignal(source.engineAgentId, AbortSignal.any([closing.signal, c.req.raw.signal, AbortSignal.timeout(320000)]))
   await permission(source, signal, request.phase === 'propose')
   const owner = isolatedScreenOwner(source.engineAgentId)
   if (request.mode === 'authority') {
    const screen = request.phase === 'propose' ? await service().ensure(owner, signal) : await service().running(owner, signal)
    const result = await service().toolInstall(screen.target, { mode: 'probe' }, signal, active => permission(source, active, request.phase === 'propose'))
    if (result.available !== true || typeof result.workspaceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(result.workspaceFingerprint)) throw new Error('Installation capability unavailable')
    return c.json({ guest: { ...screen.target, workspaceFingerprint: result.workspaceFingerprint } })
   }
   if (!request.identity || !request.operationId || !request.packages) throw new Error('Reviewed operation is required')
   const identity = request.identity, operationId = request.operationId
   if (identity.guest.engineAgentId !== source.engineAgentId || identity.runId !== source.runId || identity.toolCallId !== source.toolCallId || identity.guest.launchNonce !== runtime.launchNonce) throw new Error('Installation source changed')
   if (executing.has(operationId) || (request.mode === 'install' && cancelled.has(operationId))) throw new Error('Installation is already active or cancelled')
   const controller = new AbortController(), linked = AbortSignal.any([signal, controller.signal]), release = beginDesktopAgentWork(source.engineAgentId)
   const work = service().toolInstall(identity.guest, { mode: request.mode, operationId, workspaceFingerprint: identity.guest.workspaceFingerprint, packages: request.packages }, linked, active => permission(source, active))
   executing.set(operationId, { source: key, controller, target: identity.guest, done: work })
   try { const value = await work; return c.json({ result: desktopToolInstallGuestResultSchema.parse(value.result) }) }
   finally { executing.delete(operationId); release() }
  } catch { return c.json({ error: 'The reviewed installation is unavailable or its result is uncertain.' }, 409) }
 })
 function tools(ctx: RunContext): ToolSet {
  const grants = ctx.agent.config.tools.desktopToolGrants as Record<string, boolean | undefined> | undefined
  if (ctx.agent.config.ephemeral || !ctx.agent.config.selfImprovement.enabled || !ctx.agent.config.selfImprovement.allowToolInstall || grants?.toolInstall !== true) return {}
  return { tool_install: tool({ description: 'Propose exact npm package@version targets for this coworker’s isolated computer. The user must approve before installation. Packages stay inside that computer.', inputSchema: desktopToolInstallInputSchema,
   execute: async (raw, options) => {
    const input = desktopToolInstallInputSchema.parse(raw)
    if (!ctx.runId || !ctx.abortSignal || !options.toolCallId) throw new Error('An active installation invocation is required')
    const source = { engineAgentId: ctx.agent.id, sessionId: ctx.sessionId, runId: ctx.runId, toolCallId: options.toolCallId }
    const signal = AbortSignal.any([ctx.abortSignal, closing.signal, ...(options.abortSignal ? [options.abortSignal] : [])]), key = sourceKey(source)
    const release = beginDesktopAgentWork(ctx.agent.id); invocations.set(key, signal)
    try {
     await permission(source, signal, true)
     const response = await fetch(`${runtime.app.origin}/api/desktop/internal/tool-install`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ launchNonce: runtime.launchNonce, source, packages: input.packages }), signal })
     const body = await bounded(response, signal)
     if (!response.ok) throw new Error('Installation proposal could not be saved')
     const result = desktopToolInstallSnapshotSchema.parse(body.installation)
     if (result.runId !== source.runId || result.toolCallId !== source.toolCallId) throw new Error('Installation proposal source changed')
     return result
    } finally { invocations.delete(key); release() }
   } }) }
 }
 const binding = { routes, tools, async close() { closing.abort(); await Promise.allSettled([...executing.values()].map(item => item.done)) } }
 installed = binding; return binding
}
let installed: ReturnType<typeof bindDesktopToolInstall> | undefined
export function readDesktopToolInstall() { return installed }
