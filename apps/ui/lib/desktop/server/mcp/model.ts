export type DeviceOAuthClient = { clientId: string; verificationUri: string }
export type RemoteServer = { id?: string; transport?: 'http' | 'sse'; name: string; url: string; revision: string; hasBearer: boolean; deviceClient?: DeviceOAuthClient }
export type RemoteMcpConfiguration = { name: string; url: string; bearer?: string; revision?: string; deviceClient?: DeviceOAuthClient | null }
export type RemoteTool = { name: string; description?: string; inputSchema: Record<string, unknown> }
export function endpoint(value: string): string {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS endpoint without credentials, query or fragment')
    return url.href
}
export function serverName(value: string): string {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new Error('Name must be 1–64 letters, digits, underscores or hyphens')
    return value
}
