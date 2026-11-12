import { hiddenWorkspaceError } from './workspace-access.mjs'

function workspaceRequest(runtime, { agentId, chatId, runId }) {
    if (!runtime?.app?.origin || !runtime.app.sessionToken) throw hiddenWorkspaceError()
    const address = new URL('/api/desktop/phone-pairing', runtime.app.origin)
    if (agentId) address.searchParams.set('agentId', agentId)
    if (chatId) address.searchParams.set('chatId', chatId)
    if (runId) address.searchParams.set('runId', runId)
    return { address, headers: { Cookie: `rerun-desktop-session=${runtime.app.sessionToken}`, Accept: 'application/json' } }
}

export async function readWorkspaceChats(runtime, target) {
    const { address, headers } = workspaceRequest(runtime, target)
    const response = await fetch(address, {
        headers,
        redirect: 'error', signal: AbortSignal.timeout(5000),
    })
    if (response.status === 404) throw hiddenWorkspaceError()
    if (!response.ok) throw new Error('Local workspace is unavailable')
    return response.json()
}

export async function readWorkspaceReply(runtime, target, signal) {
    const { address, headers } = workspaceRequest(runtime, target)
    address.searchParams.set('stream', '1')
    const response = await fetch(address, { headers, redirect: 'error', signal })
    if (response.status === 204) return null
    if (response.ok && response.body && response.headers.get('content-type')?.split(';')[0] === 'application/x-ndjson') return response.body
    void response.body?.cancel().catch(() => {})
    if (response.status === 404) throw hiddenWorkspaceError()
    throw new Error('Local reply is unavailable')
}

export async function sendWorkspaceMessage(runtime, { agentId, chatId, runId, text }) {
    const { address, headers } = workspaceRequest(runtime, { agentId, chatId })
    const response = await fetch(address, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8500),
        headers: { ...headers, Origin: runtime.app.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, runId }),
    })
    if (response.status === 404) throw hiddenWorkspaceError()
    if (response.status === 202 && (await response.json()).runId === runId) return null
    void response.body?.cancel().catch(() => {})
    switch (response.status) {
        case 400: return { code: 'invalid_message', status: 400 }
        case 403: return { code: 'coworker_unavailable', status: 403 }
        case 409: return { code: 'turn_blocked', status: 409 }
        default: return { code: 'unavailable', status: 502 }
    }
}

export async function stopWorkspaceTurn(runtime, target) {
    const { address, headers } = workspaceRequest(runtime, target)
    const response = await fetch(address, {
        method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(8500),
        headers: { ...headers, Origin: runtime.app.origin },
    })
    if (response.status === 404) throw hiddenWorkspaceError()
    if (response.status === 200 && (await response.json()).runId === target.runId) return null
    void response.body?.cancel().catch(() => {})
    return response.status === 409 ? { code: 'turn_blocked', status: 409 } : { code: 'unavailable', status: 502 }
}
