/** Ordered team-build progress — mirrors I's DesktopForemanBuild / BuildItem. */

export type DesktopForemanBuildItemStatus =
    | 'queued'
    | 'reserved'
    | 'creating'
    | 'created'
    | 'failed'
    | 'uncertain'
    | 'stopped'

export type DesktopForemanBuildItemView = {
    itemKey: string
    name: string
    status: DesktopForemanBuildItemStatus
    error: string | null
    failure: string | null
    /** Exact created coworker id when known (first agentIds entry). */
    agentId: string | null
    /** Exact created Box / space id when known. */
    boxId: string | null
    /** Exact session id for setup chat when known. */
    sessionId: string | null
    lead: boolean
    order: number
}

export type DesktopForemanBuildProgressView = {
    buildId: string
    revisionId: string
    chatId: string
    workspaceId: string
    status: 'reserved' | 'running' | 'completed' | 'partial' | 'stopped' | 'failed' | 'uncertain'
    /** Original behavior: team creation does not automatically start every coworker. */
    autoStartCoworkers: false
    leadItemKey: string | null
    setup: {
        state: 'not_started' | 'pending' | 'started' | 'failed' | 'uncertain' | 'unavailable'
        agentId: string | null
        sessionId: string | null
        error: string | null
    }
    items: DesktopForemanBuildItemView[]
}

/** Map I's DesktopForemanBuild into a presentation progress view. */
export function fromContractBuild(build: {
    buildId: string
    revisionId: string
    state: DesktopForemanBuildProgressView['status']
    leadItemKey: string | null
    setup: DesktopForemanBuildProgressView['setup']
    items: Array<{
        itemKey: string
        order: number
        title: string
        state: DesktopForemanBuildItemStatus
        created: { agentIds: string[]; spaceId: string; sessionId: string | null } | null
        failure: string | null
        error: string | null
        lead: boolean
    }>
}, chat: { workspaceId: string; chatId: string }): DesktopForemanBuildProgressView {
    return {
        buildId: build.buildId,
        revisionId: build.revisionId,
        workspaceId: chat.workspaceId,
        chatId: chat.chatId,
        status: build.state,
        autoStartCoworkers: false,
        leadItemKey: build.leadItemKey,
        setup: build.setup,
        items: build.items.map(item => ({
            itemKey: item.itemKey,
            name: item.title,
            status: item.state,
            error: item.error,
            failure: item.failure,
            agentId: item.created?.agentIds[0] ?? null,
            boxId: item.created?.spaceId ?? null,
            sessionId: item.created?.sessionId ?? null,
            lead: item.lead,
            order: item.order,
        })),
    }
}

export function projectBuildProgress(input: DesktopForemanBuildProgressView | null): {
    items: DesktopForemanBuildItemView[]
    partial: boolean
    completedCount: number
    failedCount: number
    navigable: Array<{ itemKey: string; agentId: string; boxId: string | null; sessionId: string | null }>
} {
    if (!input) return { items: [], partial: false, completedCount: 0, failedCount: 0, navigable: [] }
    const items = [...input.items].sort((a, b) => a.order - b.order)
    const completedCount = items.filter(item => item.status === 'created').length
    const failedCount = items.filter(item => item.status === 'failed' || item.status === 'uncertain').length
    const partial = input.status === 'partial' || (completedCount > 0 && (failedCount > 0 || input.status === 'running'))
    const navigable = items.flatMap(item =>
        item.status === 'created' && item.agentId
            ? [{ itemKey: item.itemKey, agentId: item.agentId, boxId: item.boxId, sessionId: item.sessionId }]
            : [],
    )
    return { items, partial, completedCount, failedCount, navigable }
}

export function buildItemLabel(item: DesktopForemanBuildItemView): string {
    switch (item.status) {
        case 'queued':
        case 'reserved':
            return 'Waiting'
        case 'creating':
            return 'Creating'
        case 'created':
            return 'Created'
        case 'failed':
            return item.error || item.failure || 'Failed'
        case 'uncertain':
            return item.error || 'Uncertain'
        case 'stopped':
            return 'Stopped'
    }
}
