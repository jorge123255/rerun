import type { DesktopForemanBinding, DesktopForemanChatRef, DesktopForemanLiveEvent, DesktopForemanModelRef, DesktopForemanDiscoveryEvent } from '@rerun/contracts'

// Everything the Foreman runtime cannot decide alone is supplied by root. A missing authority
// fails closed: there is no default, in-memory or optimistic substitute.

// A definitive refusal: the effect did not and will not happen for this request id.
export class ForemanRefusal extends Error {
    constructor(readonly failure: 'creation_failed' | 'template_failed' | 'box_failed' | 'deleted' | 'replaced' | 'workspace_changed' | 'model_unavailable', message: string) {
        super(message)
    }
}

// Receipt lookups never guess by name: only the exact request id the runtime reserved counts.
export type ForemanReceipt<T> = { state: 'present'; value: T } | { state: 'absent' } | { state: 'unknown' } | { state: 'replaced' }

export type ForemanRunAuthority = {
    // Exact current workspace/chat/run/model; a saved or finished run is never live.
    isLive(binding: DesktopForemanBinding): Promise<boolean>
    // Read-only: the run currently admitted for this chat, or null. Must never start one.
    currentLive(chat: DesktopForemanChatRef): Promise<{ runId: string; model: DesktopForemanModelRef } | null>
    // Whether a browser is observing exactly this chat and run right now.
    isObserved(chat: DesktopForemanChatRef, runId: string): Promise<boolean>
    // Sends the one follow-up user turn on the chat's selected model. Idempotent per requestId.
    sendFollowUp(input: { chat: DesktopForemanChatRef; requestId: string; text: string }): Promise<{ runId: string }>
    lookupFollowUp(requestId: string): Promise<ForemanReceipt<{ runId: string }>>
    modelAvailable(model: DesktopForemanModelRef): Promise<boolean>
}

export type ForemanWorkspaceAuthority = {
    currentWorkspaceId(): Promise<string>
    agentCount(): Promise<number>
}

export type ForemanCoworkerSpec = {
    requestId: string
    spaceId: string
    name: string
    description: string
    soulMd: string
    installMd: string
    model: DesktopForemanModelRef
}

// Root binds these onto the accepted Box/creation/template/setup operations with their own
// receipts. Created coworkers start disabled for runs (no kickoff), setup pending, and with the
// default conservative tool grants: the plan carries no permissions.
export type ForemanCreationAuthority = {
    // Explicit user recovery only. Replays the exact pending durable body with its original ID.
    // Startup/read inspection must never call this. No journal entry means no effect.
    resumePending?(requestId: string): Promise<void>
    ensureBox(input: { requestId: string; name: string; order: number }): Promise<{ spaceId: string }>
    lookupBox(requestId: string): Promise<ForemanReceipt<{ spaceId: string }>>
    createCoworker(spec: ForemanCoworkerSpec): Promise<{ agentId: string }>
    lookupCoworker(requestId: string): Promise<ForemanReceipt<{ agentId: string; spaceId: string }>>
    installTemplate(input: { requestId: string; templateId: string; spaceId: string; focus?: string }): Promise<{ agentIds: string[] }>
    lookupTemplateInstall(requestId: string): Promise<ForemanReceipt<{ agentIds: string[]; spaceId: string }>>
}

export type ForemanSetupAuthority = {
    // The accepted setup gate's explicit Start, for exactly one coworker. Idempotent per requestId.
    startSetup(input: { requestId: string; agentId: string }): Promise<{ sessionId: string }>
    lookupSetup(requestId: string): Promise<ForemanReceipt<{ sessionId: string }>>
}

export type ForemanEventSink = { publish(event: DesktopForemanLiveEvent): void }

export type ForemanDiscoveryCollector = (input: { url: string; signal: AbortSignal; emit: (event: DesktopForemanDiscoveryEvent) => void }) => Promise<void>

export type ForemanAuthorities = {
    run: ForemanRunAuthority
    workspace: ForemanWorkspaceAuthority
    creation: ForemanCreationAuthority
    setup: ForemanSetupAuthority
    events: ForemanEventSink
    collectDiscovery: ForemanDiscoveryCollector | null
    now?: () => Date
    id?: () => string
}

export function requireAuthorities(value: Partial<ForemanAuthorities> | null | undefined): ForemanAuthorities {
    const missing = (['run', 'workspace', 'creation', 'setup', 'events'] as const).filter(key => !value?.[key])
    if (missing.length) throw new Error(`Foreman runtime is not wired: missing ${missing.join(', ')} authority.`)
    return { collectDiscovery: null, ...value } as ForemanAuthorities
}
