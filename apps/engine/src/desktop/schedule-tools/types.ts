import type { DesktopScheduleToolNotice, DesktopScheduleToolOperation, DesktopScheduleToolOutcome, Provider } from '@rerun/contracts'

export type DesktopScheduleDefinition = {
    slug: string
    name: string
    description: string
    enabled: boolean
    cron: string | null
    runAt: string | null
    timezone: string | null
    lastRunAt: string | null
    connectionId: string | null
    provider: Provider | null
    model: string | null
    body: string
    createdAt: string
}

export type DesktopScheduleConnectedModel = { provider: string; model: string }

export type DesktopScheduleOwner = {
    localAgentId: string
    engineAgentId: string
    enabled: boolean
    deleting: boolean
    setupPending: boolean
    /** Explicit schedule-management grant. The run grant is not this flag. */
    scheduleManage: boolean
    /** Usable desktop model this coworker will actually run. Null when none is connected. */
    connectedModel: DesktopScheduleConnectedModel | null
}

export type DesktopScheduleRun = { agentId: string; sessionId: string; status: string }

export type DesktopScheduleFilePort = {
    list(engineAgentId: string): Promise<DesktopScheduleDefinition[]>
    read(engineAgentId: string, slug: string): Promise<DesktopScheduleDefinition | null>
    /** Compare-and-swap the definition. Preserve lastRunAt from the current file. Null deletes the definition only. */
    replace(engineAgentId: string, slug: string, expected: DesktopScheduleDefinition | null, next: DesktopScheduleDefinition | null, admission?: () => Promise<void>): Promise<DesktopScheduleDefinition | null>
}

export type DesktopScheduleIntentKind = 'create' | 'update' | 'edit' | 'delete'

export type DesktopScheduleIntent = {
    requestId: string
    fingerprint: string
    kind: DesktopScheduleIntentKind
    slug: string
    text: string
    before: DesktopScheduleDefinition | null
    after: DesktopScheduleDefinition | null
    revision: string
    resultJson: string | null
}

export type DesktopScheduleReceipt = {
    outcome: DesktopScheduleToolOutcome | 'interrupted'
    operation: DesktopScheduleToolOperation
    text: string
    slug: string
    revision: string | null
}

export type DesktopScheduleIntentStore = {
    findIntent(engineAgentId: string, requestId: string): Promise<DesktopScheduleIntent | null>
    findPending(engineAgentId: string, slug: string): Promise<DesktopScheduleIntent | null>
    listPending(engineAgentId: string): Promise<DesktopScheduleIntent[]>
    reserve(engineAgentId: string, intent: DesktopScheduleIntent): Promise<void>
    /** Terminal write. A second call must leave the first receipt unchanged. */
    complete(engineAgentId: string, requestId: string, resultJson: string): Promise<void>
}

export type DesktopScheduleToolAuthority = {
    assertActive(): void
    resolveOwner(engineAgentId: string): Promise<DesktopScheduleOwner>
    readRun(engineAgentId: string, runId: string): Promise<DesktopScheduleRun | null>
    /** Best-effort panel refresh after a committed definition change. Must not start a run. */
    notify?(notice: DesktopScheduleToolNotice): Promise<void>
}

export type DesktopScheduleToolContext = {
    runId?: string
    sessionId?: string
    abortSignal?: AbortSignal
}
