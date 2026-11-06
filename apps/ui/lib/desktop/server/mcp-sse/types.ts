import type { DesktopMcpSseCall, DesktopMcpSseRef, DesktopMcpSseTool, DesktopMcpSseOutcome } from '@rerun/contracts'
import type { RemoteServer, RemoteTool } from '../mcp/model'
import type { McpRunIdentity } from '../mcp/bridge'

export type SseAuthority = {
    server: RemoteServer & { id: string; transport: 'sse' }
    credentialGeneration: string
    credentialHandle: unknown
    check(): void
}
export type SseScope = { ref: DesktopMcpSseRef; action: 'read' | 'use' | 'call' | 'close'; run?: McpRunIdentity }
export type SseWireRequest = {
    url: string; method: 'GET' | 'POST'; body?: string; authority: SseAuthority
    signal: AbortSignal; guard(): Promise<void>
}
export type SseWireResponse = {
    status: number; contentType: string; body: ReadableStream<Uint8Array> | null
    close(signal: AbortSignal): Promise<void>
}
export type SseNetwork = (request: SseWireRequest) => Promise<SseWireResponse>
export type SseTicket = { assertCurrent(): void; release(): void }
export type SseCallLedger = {
    claim(call: DesktopMcpSseCall, fingerprint: string, signal: AbortSignal): Promise<'new' | 'existing'>
    settle(call: DesktopMcpSseCall, fingerprint: string, outcome: DesktopMcpSseOutcome): Promise<void>
}
export type SseDependencies = {
    authorize(scope: SseScope, signal: AbortSignal): Promise<SseAuthority>
    lifecycle: { admit(agentId: string, name: string, controller: AbortController): SseTicket }
    network: SseNetwork
    protect(value: unknown, authority: SseAuthority): unknown
    normalizeTool(tool: RemoteTool): DesktopMcpSseTool
    ledger: SseCallLedger
    shutdownSignal: AbortSignal
}
