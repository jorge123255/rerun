/** Injected action ports for I's canonical runtime and root mounting. */

import type { DesktopPlanDecisionRequest, DesktopPlanDecisionResult } from './decision'
import type { DesktopForemanBuildProgressView } from './build-progress'
import type { DesktopDiscoveryEvent } from './discovery-view'
import type { DesktopForemanNavigationRequest } from './navigation'
import type { DesktopTrustedPlanSnapshot } from './plan-view'
import type { DesktopForemanChatRef, DesktopForemanBinding } from './identity'
import type { DesktopForemanPersistedUi, DesktopForemanPersistence } from './persistence'

export type DesktopForemanConversationCallbacks = {
    sendMessage: (text: string) => boolean | Promise<boolean>
    stop: () => void | Promise<void>
    focusComposer?: () => void
}

export type DesktopForemanDecisionPort = {
    submit: (request: DesktopPlanDecisionRequest, signal?: AbortSignal) => Promise<DesktopPlanDecisionResult>
}

export type DesktopForemanBuildPort = {
    readProgress: (chat: DesktopForemanChatRef, signal?: AbortSignal) => Promise<DesktopForemanBuildProgressView | null>
    /** start_lead_setup / stop / resume — I's DesktopForemanBuildAction. */
    act: (
        action:
            | { action: 'stop'; requestId: string; chat: DesktopForemanChatRef; buildId: string }
            | { action: 'resume'; requestId: string; chat: DesktopForemanChatRef; buildId: string }
            | { action: 'start_lead_setup'; requestId: string; chat: DesktopForemanChatRef; buildId: string; itemKey: string },
        signal?: AbortSignal,
    ) => Promise<DesktopForemanBuildProgressView | { error: string; uncertain?: boolean }>
}

export type DesktopForemanDiscoveryPort = {
    subscribe: (chat: DesktopForemanChatRef, onEvent: (event: DesktopDiscoveryEvent) => void, signal?: AbortSignal) => () => void
    capabilities: () => { available: boolean; reason?: string; unavailableSources?: string[] }
}

export type DesktopForemanNavigationPort = {
    dispatch: (request: DesktopForemanNavigationRequest) => void | Promise<void>
}

export type DesktopForemanPlanPort = {
    readShownPlan: (chat: DesktopForemanChatRef, signal?: AbortSignal) => Promise<DesktopTrustedPlanSnapshot | null>
    /** Trusted conversation projection (I's DesktopForemanConversationView shape). */
    readConversationView: (chat: DesktopForemanChatRef, signal?: AbortSignal) => Promise<{
        contractVersion: 1
        chat: DesktopForemanChatRef
        phase: 'discover' | 'plan' | 'build' | 'companion'
        live: { runId: string; model: { connectionId: string; model: string } } | null
        currentRevisionId: string | null
        blocked: 'decision_uncertain' | 'build_uncertain' | 'setup_uncertain' | null
    } | null>
}

export type DesktopForemanRoutinesPort = {
    list: (signal?: AbortSignal) => Promise<{
        available: boolean
        reason?: string
        routines: Array<{
            agentId: string
            slug: string
            name: string
            enabled: boolean
            frequency: string
            nextRunAt: string | null
            runningSessionId?: string | null
        }>
    }>
}

export type DesktopForemanActionPorts = {
    conversation: DesktopForemanConversationCallbacks
    decisions: DesktopForemanDecisionPort
    build: DesktopForemanBuildPort
    discovery: DesktopForemanDiscoveryPort
    navigation: DesktopForemanNavigationPort
    plans: DesktopForemanPlanPort
    routines: DesktopForemanRoutinesPort
    persistence: DesktopForemanPersistence
    /** Optional live binding for the open chat — null when historical. */
    liveBinding?: DesktopForemanBinding | null
}

export function requirePort<T>(port: T | null | undefined, label: string): T {
    if (!port) throw new Error(`${label} is not wired. Root must inject the Foreman adapter.`)
    return port
}

export async function saveForemanUiIfMatching(
    persistence: DesktopForemanPersistence,
    snapshot: DesktopForemanPersistedUi,
): Promise<void> {
    if (!snapshot.workspaceId || !snapshot.chatId) return
    await persistence.save(snapshot)
}
