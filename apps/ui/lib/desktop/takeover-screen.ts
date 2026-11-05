import { defaultScreenApi } from './screen-session'

export function takeoverScreenApi(sessionId: string, takeoverId: string): typeof defaultScreenApi {
    const endpoint = `/api/desktop/sessions/${encodeURIComponent(sessionId)}/takeover`
    const call = async (body: Record<string, unknown>, signal?: AbortSignal) => {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, takeoverId, requestId: crypto.randomUUID() }), signal })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error ?? 'The browser request could not be opened.')
        return result
    }
    return { ...defaultScreenApi,
        startDesktopScreenTakeover: (_agent, _url, signal) => call({ action: 'open' }, signal),
        finishDesktopScreenTakeover: (_agent, lease, signal) => call({ action: 'release', lease }, signal),
    }
}
