import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { isDesktopSubscriptionProvider, PROVIDER_LABELS, type DesktopOpencodeWindow, type PlanLimitWindow } from '@rerun/contracts'
import { isUsable } from '../agents/availability.js'
import { pendingCodexPlanLimits, refreshStaleCodexPlanLimits } from '../connections/codex-plan-limits.js'
import { isCredentialRejected } from '../connections/credential-rejections.js'
import { readBoxDefault } from '../connections/default.js'
import { isConnected } from '../connections/loader.js'
import { readPlanLimits } from '../connections/plan-limits.js'
import { listConnections } from '../connections/registry.js'
import type { LoadedConnection } from '../connections/types.js'
import { deadlineSignal, raceAbort } from '../lib/abort.js'
import type { RunContext } from '../runtime/context.js'
import { readDesktopOpencodeLimits, refreshStaleDesktopOpencodeLimits } from './opencode/limits.js'
import { desktopOpencodeCredential } from './opencode/registry.js'
import { desktopProviderAllowed } from './policy.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from './tool-grants.js'
import { assertDesktopRunAdmission } from './workspace-admission.js'

const QUOTA_WAIT_MS = 5_000

async function workspaceConnections() {
    const connections = await listConnections().catch(() => { throw new Error('Could not read workspace AI providers.') })
    return connections.filter(connection => desktopProviderAllowed(connection.config.provider, connection.id))
}

// Matches Settings' usage cache. A reading never crosses an OpenCode workspace or key revision.
function opencodeScope(connection: LoadedConnection) {
    const view = connection.opencode
    return view && { workspaceId: view.workspaceId, connectionId: connection.id + ':' + view.revision }
}

async function refreshOpencode(connection: LoadedConnection, signal: AbortSignal) {
    const scope = opencodeScope(connection)
    if (!scope) return
    const apiKey = await desktopOpencodeCredential(connection, signal)
    signal.throwIfAborted()
    await refreshStaleDesktopOpencodeLimits({ ...scope, apiKey, signal, fetch })
}

async function refreshQuota(connections: LoadedConnection[], stop: AbortSignal) {
    const eligible = connections.filter(connection => isConnected(connection) && !isCredentialRejected(connection.id))
    const signal = deadlineSignal(QUOTA_WAIT_MS, stop)
    signal.throwIfAborted()
    refreshStaleCodexPlanLimits(eligible)
    await raceAbort(Promise.allSettled(eligible.map(connection => connection.opencode
        ? refreshOpencode(connection, signal)
        : connection.config.provider === 'codex' ? pendingCodexPlanLimits(connection.id) : undefined)), signal).catch(() => stop.throwIfAborted())
}

function describeConnection(connection: LoadedConnection) {
    const provider = connection.config.provider
    const connected = isConnected(connection)
    const credentialRejected = isCredentialRejected(connection.id)
    const scope = opencodeScope(connection)
    const reading = !connected || credentialRejected ? null
        : scope ? readDesktopOpencodeLimits(scope.workspaceId, scope.connectionId)
            : provider === 'codex' || provider === 'claude' ? readPlanLimits(connection.id) : null
    const windows = reading?.windows.map(({ kind, label, usedPercent, resetsAt }: PlanLimitWindow | DesktopOpencodeWindow) =>
        ({ kind, label, usedPercent, resetsAt })) ?? []
    const activeWindows = windows.filter(window => window.resetsAt === null || Date.parse(window.resetsAt) > Date.now())
    return {
        id: connection.id,
        name: connection.config.name,
        provider: PROVIDER_LABELS[provider],
        billing: scope ? 'opencode_go_or_console'
            : provider === 'claude' || provider === 'codex' || isDesktopSubscriptionProvider(provider) ? 'subscription' : 'api_key',
        connected,
        credentialRejected,
        models: credentialRejected ? [] : [...new Set([...connection.config.models, ...connection.config.extraModels])]
            .filter(model => isUsable(connection, model)),
        planLimits: reading ? { windows, readAt: reading.capturedAt, ...(scope && { scope: 'OpenCode Go' }) } : null,
        limitReached: activeWindows.length ? activeWindows.some(window => window.usedPercent >= 100) : null,
    }
}

export function desktopAiStatusTools(ctx: RunContext): ToolSet {
    if (!ctx.agent.config.enabled || !hasDesktopToolGrant(ctx.agent.config, 'aiProviders')) return {}
    return {
        ai_status: tool({
            description: 'Read which connection, provider and model answer this run, the workspace default, and the available AI providers and models. Reports last known Codex, Claude and OpenCode Go quota windows and their reset times when available. A null reading means unknown, never zero or unlimited. API keys have no quota reading here. Use this tool to answer questions about models, providers or limits. Change selections in Settings.',
            inputSchema: z.strictObject({}),
            execute: async (_input, options) => {
                const stop = AbortSignal.any([ctx.abortSignal, options.abortSignal].filter(signal => signal !== undefined))
                const request = { ...ctx, abortSignal: stop }
                await requireDesktopToolGrant(request, 'aiProviders')
                const admission = assertDesktopRunAdmission()
                const connections = await workspaceConnections()
                await requireDesktopToolGrant(request, 'aiProviders')
                assertDesktopRunAdmission(admission)
                await refreshQuota(connections, stop)
                // Re-resolve after the quota reads so a replaced or disconnected provider cannot
                // return the retired credential's readings.
                const [currentConnections, savedDefault] = await Promise.all([workspaceConnections(), readBoxDefault()])
                await requireDesktopToolGrant(request, 'aiProviders')
                assertDesktopRunAdmission(admission)
                const current = ctx.agent.resolved.connection
                return {
                    current: {
                        connectionId: current?.id ?? null, connectionName: current?.config.name ?? null,
                        provider: PROVIDER_LABELS[ctx.provider], model: ctx.model,
                    },
                    workspaceDefault: savedDefault ? { connectionId: savedDefault.connectionId, model: savedDefault.model } : null,
                    connections: currentConnections.map(describeConnection),
                    rerunCredit: null,
                }
            },
        }),
    }
}
