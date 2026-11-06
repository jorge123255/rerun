import type { ExternalMcpDispatchPort } from '@rerun/contracts'

let port: ExternalMcpDispatchPort | null = null

/** C calls this once. A second, different port is refused so an in-flight call keeps its adapter. */
export function registerExternalMcpDispatch(next: ExternalMcpDispatchPort): void {
    if (port && port !== next) throw new Error('External MCP dispatch is already registered.')
    port = next
}

export function readExternalMcpDispatch(): ExternalMcpDispatchPort | null {
    return port
}
