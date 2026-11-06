import type { DesktopApiConnectionView, DesktopApiRemovalPlan, ConnectionSummary } from '@rerun/contracts'

export function apiConnectionSummary(connection: DesktopApiConnectionView): ConnectionSummary {
    return { id: connection.connectionId, provider: connection.provider, name: connection.name, models: connection.models,
        extraModels: connection.extraModels, baseUrl: connection.baseUrl, connected: connection.connected,
        credentialRejected: connection.credentialRejected, createdAt: connection.createdAt, planLimits: null }
}
export function apiCredentialStatus(connection: DesktopApiConnectionView): string {
    return connection.credentialRejected ? 'Key rejected' : connection.connected ? 'Key saved' : 'Key missing'
}
export function apiEndpointDisplay(value: string): string {
    try { return new URL(value).origin } catch { return 'Unavailable endpoint' }
}
export function removalConsequences(plan: DesktopApiRemovalPlan): string[] {
    const lines = plan.usage.agents.map(agent => `${agent.name} (${agent.id}) will fall back to the workspace default model.`)
    for (const item of plan.usage.automations) lines.push(`${item.kind === 'schedule' ? 'Schedule' : 'Trigger'} ${item.slug} (${item.agentId}) will fall back to the workspace default model.`)
    if (plan.usage.isBoxDefault) lines.push('This connection holds the workspace default model. That saved default will be cleared. Coworkers without their own model will need another available default.')
    if (!lines.length) lines.push('The credential is removed from the workspace. No saved coworker, automation or workspace default points to it.')
    for (const run of plan.pendingRuns) lines.push(`Run ${run.runId}, chat ${run.sessionId}: ${run.status} (${run.connectionRevision}).`)
    if (plan.preservedConnectionIds.length) lines.push(`These connections are kept: ${plan.preservedConnectionIds.join(', ')}.`)
    if (!plan.canRemove) lines.push(plan.reason || 'This connection cannot be removed right now.')
    return lines
}
