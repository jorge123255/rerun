import type { McpRunIdentity } from '../../mcp/bridge'
import type { DesktopMcpSseTool } from '../../../../../../../packages/contracts/src/desktop-mcp-sse'
import type { ServiceTransportControl, ServiceTransportRef, ServiceTransportReceipt, ServiceTransportSnapshot } from '../../../../../../../packages/contracts/src/desktop-service-transports'
import type { TransportPlan, Template } from './compiler'
export type TrustedRun = McpRunIdentity
export type TransportAction = 'read' | 'discover' | 'call' | 'close'
export type TransportAuthority = {
    ref: ServiceTransportRef; methodId: string; credentialGeneration: string; configurationGeneration: string;
    plan: TransportPlan; engineOwnerId: string; enabled: boolean; appsGranted: boolean; remoteGranted: boolean; programGranted: boolean;
    check(): void;
}
export type ResolvedTransport = { transport: 'sse'; url: string; bearer?: string } | {
    transport: 'stdio'; executable: string; args: string[]; env: Record<string, string>; executableIdentity: string;
}
export type ValuePort = {
    read(ref: ServiceTransportRef, inputKey: string, signal: AbortSignal): Promise<{ kind: 'public'; value: string } | { kind: 'secret'; reference: unknown } | null>
    unseal(ref: ServiceTransportRef, reference: unknown, signal: AbortSignal): Promise<string>
    oauthBearer?(authority: TransportAuthority, signal: AbortSignal): Promise<string>
}
export type ProgramPort = {
    // This is E/root's approved installed-package mapping, never an installation request.
    resolve(ref: ServiceTransportRef, command: string, args: Template[], signal: AbortSignal): Promise<{ executable: string; args: Template[]; supportsEnvironment: boolean } | null>
    validateExecutable(executable: string, signal: AbortSignal): Promise<string>
    validateArguments(executable: string, args: string[], signal: AbortSignal): Promise<void>
}
export type Invocation = { requestId: string; toolCallId: string; tool: string; arguments: Record<string, unknown>; run: TrustedRun }
export type DriverContext = { authority: TransportAuthority; material: ResolvedTransport; signal: AbortSignal; guard(): Promise<void> }
export type TransportDriver = {
    status(authority: TransportAuthority, signal: AbortSignal): Promise<{ state: ServiceTransportSnapshot['state']; tools: DesktopMcpSseTool[]; failure?: ServiceTransportSnapshot['failure'] }>
    discover(context: DriverContext, requestId: string, mode: 'probe' | 'reconnect' | 'run', run?: TrustedRun): Promise<{ tools: DesktopMcpSseTool[]; observation: 'live' | 'probe' }>
    call(context: DriverContext, invocation: Invocation): Promise<unknown>
    drain(authority: TransportAuthority, signal: AbortSignal): Promise<void>
    releaseRun(authority: TransportAuthority, run: TrustedRun, signal: AbortSignal): Promise<void>
}
export type TransportReceiptKey = { ref: ServiceTransportRef; requestId: string; action: ServiceTransportReceipt['action']; run?: TrustedRun; toolCallId?: string }
export type TransportDependencies = {
    authority(ref: ServiceTransportRef, action: TransportAction, run: TrustedRun | undefined, signal: AbortSignal): Promise<TransportAuthority>
    values: ValuePort; programs: ProgramPort;
    drivers: Record<'sse' | 'stdio', TransportDriver>;
    // Atomic durable claim: UUID and (installation, engine, session, run, toolCallId) are unique.
    // Different fingerprints refuse; existing claims never repeat effects.
    receipts: {
        claim(key: TransportReceiptKey, fingerprint: string, signal: AbortSignal): Promise<'new' | 'existing'>
        read(key: TransportReceiptKey, signal: AbortSignal): Promise<ServiceTransportReceipt | null>
        settle(key: TransportReceiptKey, fingerprint: string, receipt: ServiceTransportReceipt): Promise<void>
    }
    operations: {
        admit(key: TransportReceiptKey, controller: AbortController): { check(): void; release(): void }
        // Must abort and await exact installation operations; retains failed drains for retry.
        cancel(ref: ServiceTransportRef, run: TrustedRun | undefined, signal: AbortSignal): Promise<void>
    }
    normalizeTool(tool: { name: string; description?: string; inputSchema: Record<string, unknown> }): DesktopMcpSseTool
    protect(value: unknown, authority: TransportAuthority): unknown
    assertToolNames(names: string[], ref: ServiceTransportRef): Promise<void>
    shutdownSignal: AbortSignal
}
export type ServiceTransportApi = { control(request: ServiceTransportControl, signal: AbortSignal): Promise<ServiceTransportSnapshot> }
