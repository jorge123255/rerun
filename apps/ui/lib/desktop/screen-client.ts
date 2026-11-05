export type DesktopScreenState = 'available' | 'unavailable' | 'starting' | 'taken-over' | 'disconnected'

export type DesktopScreenStatusView = {
    state: DesktopScreenState
    reason?: string
    driving: boolean
    width?: number
    height?: number
}

export type DesktopScreenTicketView = {
    socketUrl: string
    expiresAt: string
    width: number
    height: number
}

async function call<T>(agentId: string, init: RequestInit): Promise<T> {
    const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/screen`, { ...init, headers: { 'content-type': 'application/json' } })
    const body = (await response.json().catch(() => null)) as { error?: string } & T
    if (!response.ok) throw new Error(body?.error ?? 'The screen could not be reached.')
    return body
}

export function fetchDesktopScreenStatus(agentId: string, signal?: AbortSignal): Promise<DesktopScreenStatusView> {
    return call(agentId, { method: 'GET', signal, cache: 'no-store' })
}

export function requestDesktopScreenTicket(agentId: string, mode: 'watch' | 'drive', signal?: AbortSignal, lease?: string): Promise<DesktopScreenTicketView> {
    return call(agentId, { method: 'POST', body: JSON.stringify({ action: 'view', mode, ...(lease && { lease }) }), signal })
}

export function startDesktopScreenTakeover(agentId: string, url?: string, signal?: AbortSignal): Promise<{ lease: string }> {
    return call(agentId, { method: 'POST', body: JSON.stringify({ action: 'takeover', ...(url ? { url } : {}) }), signal })
}

export function finishDesktopScreenTakeover(agentId: string, lease: string, signal?: AbortSignal): Promise<{ url: string | null; expired?: boolean }> {
    return call(agentId, { method: 'POST', body: JSON.stringify({ action: 'takeover-finish', lease }), signal })
}

export function stopDesktopScreen(agentId: string, signal?: AbortSignal): Promise<{ ok: true }> {
    return call(agentId, { method: 'POST', body: JSON.stringify({ action: 'stop' }), signal })
}
