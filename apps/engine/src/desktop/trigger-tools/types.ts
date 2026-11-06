export type DesktopTriggerConnectedModel = { provider: string; model: string }

export type DesktopTriggerToolOwner = {
    localAgentId: string
    engineAgentId: string
    enabled: boolean
    deleting: boolean
}

export type DesktopTriggerToolRun = { agentId: string; sessionId: string; status: string }

/**
 * Fresh checks for one model tool call. `assertTriggerGrant` is the Triggers grant,
 * not `scheduleManage` and not a previous approval card.
 */
export type DesktopTriggerToolAuthority = {
    assertActive(): void
    resolveOwner(engineAgentId: string): Promise<DesktopTriggerToolOwner>
    assertTriggerGrant(engineAgentId: string): Promise<void>
    assertSetupClear(engineAgentId: string): Promise<void>
    readRun(engineAgentId: string, runId: string): Promise<DesktopTriggerToolRun | null>
    /** Usable desktop model, or null. A throw is treated as no model to compare. */
    connectedModel(engineAgentId: string): Promise<DesktopTriggerConnectedModel | null>
}

export type DesktopTriggerToolContext = {
    runId?: string
    sessionId?: string
    abortSignal?: AbortSignal
}
