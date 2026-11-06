import 'server-only'
import type { Client } from '@libsql/client'
import type { ExternalMcpCallContext, ExternalMcpLiveCheckInput, ExternalMcpLiveCheckResult } from '@rerun/contracts'
import { openDesktopDatabase } from '../database'
import { readDesktopRuntime, type DesktopRuntime } from '../runtime'
import { findDesktopAgent, type DesktopAgent } from '../store'

export async function externalMcpCheckpoint(context: ExternalMcpCallContext, recheck: (input: ExternalMcpLiveCheckInput) => Promise<ExternalMcpLiveCheckResult>, signal: AbortSignal) {
    signal.throwIfAborted()
    const p = context.principal
    const result = await recheck({ keyId: p.keyId, workspaceId: p.workspaceId, keyRevision: p.keyRevision, installId: p.installId, launchNonce: p.launchNonce, requestId: context.requestId, scopes: [...p.scopes] })
    signal.throwIfAborted()
    if (!result.ok) throw new Error('External authority changed.')
    return result.principal
}

export async function externalMcpGuarded<T>(context: ExternalMcpCallContext, recheck: (input: ExternalMcpLiveCheckInput) => Promise<ExternalMcpLiveCheckResult>, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    await externalMcpCheckpoint(context, recheck, signal)
    const result = await action()
    await externalMcpCheckpoint(context, recheck, signal)
    return result
}

export async function externalMcpRuntime(context: ExternalMcpCallContext, recheck: (input: ExternalMcpLiveCheckInput) => Promise<ExternalMcpLiveCheckResult>, signal: AbortSignal): Promise<DesktopRuntime> {
    const runtime = await externalMcpGuarded(context, recheck, signal, () => readDesktopRuntime())
    if (runtime.workspaceId !== context.principal.workspaceId || runtime.launchNonce !== context.principal.launchNonce) {
        throw new Error('Workspace runtime is not bound to this key.')
    }
    if (runtime.workspaceId !== context.principal.runtimeWorkspaceId) throw new Error('Runtime workspace mismatch.')
    return runtime
}

export async function externalMcpDb(runtime: DesktopRuntime, context: ExternalMcpCallContext, recheck: (input: ExternalMcpLiveCheckInput) => Promise<ExternalMcpLiveCheckResult>, signal: AbortSignal): Promise<Client> {
    return externalMcpGuarded(context, recheck, signal, () => openDesktopDatabase(runtime.dataRoot))
}

export async function externalMcpOwnedAgent(db: Client, context: ExternalMcpCallContext, recheck: (input: ExternalMcpLiveCheckInput) => Promise<ExternalMcpLiveCheckResult>, signal: AbortSignal, agentId: string): Promise<DesktopAgent> {
    const agent = await externalMcpGuarded(context, recheck, signal, () => findDesktopAgent(db, agentId))
    if (!agent || agent.workspaceId !== context.principal.workspaceId) throw new Error('Coworker not found.')
    return agent
}

export function requireConfirm(args: Record<string, unknown>, label: string) {
    if (args.confirm !== true) throw new Error(`Set confirm: true to ${label}.`)
}

export function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
}

export function requireString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`)
    return value
}
