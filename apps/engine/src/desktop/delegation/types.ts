import type { DesktopDelegationSnapshot, DesktopDelegationStop } from '../../../../../packages/contracts/src/desktop-delegation.js'
export type { DesktopDelegationSnapshot, DesktopDelegationStop }
export type Source = Pick<DesktopDelegationSnapshot, 'parentAgentId' | 'parentSessionId' | 'parentRunId' | 'toolCallId'>
export type Resource = { token: string; identity: string }
export type Record = { version: 1; digest: string; snapshot: DesktopDelegationSnapshot; resources: (Resource | null)[] }
export interface DelegationStore {
    reserve(record: Record): Promise<{ record: Record; created: boolean }>;
    save(record: Record, expectedRevision: string): Promise<void>;
    read(id: string): Promise<Record | null>;
    list(sessionId?: string): Promise<Record[]>;
}
export type Authority = {
    model: string;
    tools: readonly string[];
}
export type ProgressEvent = { type: 'step' } | { type: 'call'; tool: string; failed?: boolean } | { type: 'text'; text: string }
export interface Child {
    run(onProgress: (event: ProgressEvent) => Promise<void>): Promise<string>;
    stop(): Promise<void>;
    settled: Promise<void>;
}
export interface DelegationHost {
    // Validate owner/enabled/current run/default-off grant, including depth === 0.
    current(source: Source, signal: AbortSignal): Promise<Authority>;
    // Must explicitly certify tools that can be isolated; never infer from a family grant.
    isolatedTool(tool: string): boolean;
    // Persisted opaque token/identity must name an exact fresh empty resource, not a path to delete.
    allocate(source: Source, taskId: string): Promise<Resource>;
    create(resource: Resource, input: { task: string; context?: string; model: string; tools: readonly string[];
        authorizeTool: (tool: string) => Promise<void>; signal: AbortSignal }): Promise<Child>;
    // Recover/drain exact owned processes after restart before cleanup; refuse unknown identity.
    recover(source: Source, taskId: string): Promise<Resource | null>;
    drain(resource: Resource): Promise<void>;
    cleanup(resource: Resource): Promise<void>;
    publicText(source: Source, text: string): string;
}
export type StopReceipt = { digest: string; delegation: DesktopDelegationSnapshot }
export interface ReceiptStore {
    read(requestId: string): Promise<StopReceipt | null>;
    put(requestId: string, receipt: StopReceipt): Promise<void>;
}
