export type DesktopTeamReadAck<T> = { acknowledgement: 'ready'; value: T } | { acknowledgement: 'uncertain' }

export type DesktopTeamMember = {
    publicId: string
    engineAgentId: string
    name: string
    handle: string | null
    spaceId: string | null
    enabled: boolean
    configured: boolean
    deleting: boolean
    /** Set only when the directory already knows the machine is down. Omit to read activity. */
    reachable?: boolean
}

export type DesktopTeamCaller = {
    workspaceId: string
    publicId: string
    engineAgentId: string
}

export type DesktopTeamLookup =
    | { kind: 'member'; member: DesktopTeamMember }
    | { kind: 'other-workspace' }
    | { kind: 'missing' }
    | { kind: 'uncertain' }

export type DesktopTeamDirectory = {
    caller(engineAgentId: string): Promise<DesktopTeamCaller | null | 'uncertain'>
    members(workspaceId: string): Promise<DesktopTeamReadAck<DesktopTeamMember[]>>
    lookup(workspaceId: string, agentId: string): Promise<DesktopTeamLookup>
}

export type DesktopTeamScheduleView = {
    slug: string
    name: string
    description: string
    body: string
    cron: string | null
    runAt: string | null
    timezone: string | null
    enabled: boolean
    lastRunAt: string | null
}

export type DesktopTeamTriggerView = {
    slug: string
    name: string
    description: string
    body: string
    methods: string[]
    enabled: boolean
    fireCount: number
    lastFiredAt: string | null
}

export type DesktopTeamRunView = {
    runId: string
    status: string
    sessionId: string
    provider: string | null
    model: string | null
    trigger: string | null
    steps: number
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    costUsd: number | null
    startedAt: string
    finishedAt: string | null
    error: string | null
}

export type DesktopTeamRunDetail = DesktopTeamRunView & { output: string | null }

export type DesktopTeamToolCallView = {
    step: number
    tool: string
    input: string | null
    result: string | null
    isError: boolean
    durationMs: number | null
}

export type DesktopTeamActivity = {
    running: Array<Pick<DesktopTeamRunView, 'runId' | 'sessionId' | 'trigger' | 'startedAt' | 'steps'>>
    waitingOn: Array<{ sessionId: string; reason: string }>
    lastFinished: { runId: string; status: string; finishedAt: string | null; error: string | null } | null
}

export type DesktopTeamReads = {
    schedules(engineAgentId: string): Promise<DesktopTeamReadAck<DesktopTeamScheduleView[]>>
    triggers(engineAgentId: string): Promise<DesktopTeamReadAck<DesktopTeamTriggerView[]>>
    runs(engineAgentId: string, limit: number): Promise<DesktopTeamReadAck<DesktopTeamRunView[]>>
    run(engineAgentId: string, runId: string): Promise<DesktopTeamReadAck<DesktopTeamRunDetail | null>>
    toolCalls(engineAgentId: string, runId: string): Promise<DesktopTeamReadAck<DesktopTeamToolCallView[]>>
    activity(engineAgentId: string): Promise<DesktopTeamReadAck<DesktopTeamActivity>>
}

export type DesktopTeamAdmitContext = { agentId: string; runId?: string; sessionId?: string }
export type DesktopTeamAdmit = (ctx: DesktopTeamAdmitContext) => Promise<'ok' | 'uncertain' | 'refused'>

export type DesktopTeamReadToolContext = {
    agent: { id: string }
    runId?: string
    sessionId?: string
    abortSignal?: AbortSignal
}
