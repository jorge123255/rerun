import type { DesktopDelegationSnapshot, DesktopDelegationStop } from '@rerun/contracts'
export type { DesktopDelegationSnapshot, DesktopDelegationStop }
export type Source = Pick<DesktopDelegationSnapshot, 'parentAgentId' | 'parentSessionId' | 'parentRunId' | 'toolCallId'>
export type Resource = { token: string; identity: string }
export type OwnedOutput = { identity: string; hash: string }
export type Record = {
    version: 1
    digest: string
    snapshot: DesktopDelegationSnapshot
    resources: (Resource | null)[]
    outputs: (readonly OwnedOutput[] | null)[]
}
export interface DelegationStore {
    reserve(record: Record): Promise<{ record: Record; created: boolean }>
    save(record: Record, expectedRevision: string): Promise<void>
    read(id: string): Promise<Record | null>
    list(sessionId?: string): Promise<Record[]>
}
export type Authority = {
    connectionId: string
    model: string
    tools: readonly string[]
}
export type ProgressEvent = { type: 'step' } | { type: 'call'; tool: string; failed?: boolean } | { type: 'text'; text: string }
export interface Child {
    run(onProgress: (event: ProgressEvent) => Promise<void>): Promise<string>
    stop(): Promise<void>
    settled: Promise<void>
}
export interface DelegationHost {
    current(source: Source, signal: AbortSignal): Promise<Authority>
    isolatedTool(tool: string): boolean
    allocate(source: Source, taskId: string): Promise<Resource>
    create(resource: Resource, input: { task: string; context?: string; connectionId: string; model: string; tools: readonly string[];
        authorizeTool: (tool: string) => Promise<void>; signal: AbortSignal }): Promise<Child>
    recover(source: Source, taskId: string): Promise<Resource | null>
    drain(resource: Resource, signal: AbortSignal): Promise<void>
    admitOutputs(resource: Resource, source: Source, taskId: string, signal: AbortSignal): Promise<readonly OwnedOutput[]>
    cleanup(resource: Resource, outputs: readonly OwnedOutput[], signal: AbortSignal): Promise<void>
    publicText(source: Source, text: string): string
}
export type StopReceipt = { digest: string; source: Pick<Source, 'parentAgentId' | 'parentSessionId'>; request: DesktopDelegationStop; delegation?: DesktopDelegationSnapshot }
export interface ReceiptStore {
    read(requestId: string): Promise<StopReceipt | null>
    /** Reserve the exact owner/task/admission revision before cancellation or cleanup. */
    reserve(requestId: string, receipt: StopReceipt): Promise<StopReceipt>
    put(requestId: string, receipt: StopReceipt): Promise<void>
}
