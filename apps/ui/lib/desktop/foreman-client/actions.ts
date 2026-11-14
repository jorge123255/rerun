/** Injected action ports for I's canonical runtime and root mounting. */

import type { DesktopCoworkerMentionFields, DesktopDocumentSendSelection, DesktopForemanConversationView, DesktopForemanModelRef } from '@rerun/contracts'
import { foremanChatKey } from './identity'
import type { DesktopPlanDecisionRequest, DesktopPlanDecisionResult } from './decision'
import type { DesktopForemanBuildProgressView } from './build-progress'
import type { DesktopDiscoveryEvent } from './discovery-view'
import type { DesktopForemanNavigationRequest } from './navigation'
import type { DesktopTrustedPlanSnapshot } from './plan-view'
import type { DesktopForemanChatRef, DesktopForemanBinding } from './identity'
import type { DesktopForemanPersistedUi, DesktopForemanPersistence } from './persistence'

export type PrepareForemanDocuments = (model: DesktopForemanModelRef | null) => Promise<DesktopDocumentSendSelection | undefined>
export type DesktopForemanMessageOptions = DesktopCoworkerMentionFields & { prepareDocuments?: PrepareForemanDocuments }
export type DesktopForemanConversationCallbacks = {
    sendMessage: (text: string, signal?: AbortSignal, options?: DesktopForemanMessageOptions) => boolean | Promise<boolean>
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
    /** Canonical view retains persisted discoveries, revisions and build state. */
    readConversationView: (chat: DesktopForemanChatRef, signal?: AbortSignal) => Promise<DesktopForemanConversationView | null>
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

// One ordered writer per persistence adapter and exact chat. A load after remount also
// waits for already admitted writes, so an old response cannot overwrite a newer draft.
const retainedSnapshots = new Map<string, DesktopForemanPersistedUi>()
const pendingSaves = new Set<Promise<void>>()
const failedSaves = new Set<string>()
export const hasPendingDesktopForemanUiSaves = () => pendingSaves.size > 0 || failedSaves.size > 0
export async function flushDesktopForemanUiSaves(): Promise<boolean> {
    while (pendingSaves.size) await Promise.allSettled([...pendingSaves])
    return failedSaves.size === 0
}
const writes = new WeakMap<DesktopForemanPersistence, Map<string, Promise<void>>>()
function pendingWrites(persistence: DesktopForemanPersistence) {
    let pending = writes.get(persistence)
    if (!pending) { pending = new Map(); writes.set(persistence, pending) }
    return pending
}
export async function loadForemanUiAfterWrites(persistence: DesktopForemanPersistence, chat: DesktopForemanChatRef) {
    await pendingWrites(persistence).get(foremanChatKey(chat))?.catch(() => undefined)
    const saved = await persistence.load(chat)
    return structuredClone(retainedSnapshots.get(foremanChatKey(chat)) ?? saved)
}
export function saveForemanUiIfMatching(persistence: DesktopForemanPersistence, snapshot: DesktopForemanPersistedUi): Promise<void> {
    if (!snapshot.workspaceId || !snapshot.chatId) return Promise.reject(new Error('Foreman chat is unavailable.'))
    const pending = pendingWrites(persistence)
    const key = foremanChatKey(snapshot)
    const immutable = structuredClone(snapshot)
    retainedSnapshots.set(key, immutable)
    const next = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => persistence.save(immutable))
    pending.set(key, next)
    pendingSaves.add(next)
    void next.then(() => {
        pendingSaves.delete(next)
        failedSaves.delete(key)
        if (retainedSnapshots.get(key) === immutable) retainedSnapshots.delete(key)
    }, () => {
        pendingSaves.delete(next)
        failedSaves.add(key)
    })
    void next.then(() => { if (pending.get(key) === next) pending.delete(key) }, () => { if (pending.get(key) === next) pending.delete(key) })
    return next
}
