'use client'

import { desktopMcpSignInDecisionSchema, desktopMcpSignInResponseSchema, type DesktopMcpSignInDecision, type DesktopMcpSignInResponse } from '../../../../packages/contracts/src/desktop-mcp-sign-in'

const url = (sessionId: string) => `/api/desktop/sessions/${encodeURIComponent(sessionId)}/mcp-sign-in`

export async function readDesktopMcpSignIn(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<DesktopMcpSignInResponse> {
    const response = await fetch(url(sessionId), { cache: 'no-store', signal: options.signal })
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Could not load the MCP sign-in request.')
    return desktopMcpSignInResponseSchema.parse(body)
}

export type DesktopMcpSignInAction = 'connect' | 'status' | 'complete' | 'decline' | 'cancel' | 'recover'
export type DesktopMcpSignInActionResult =
    | { kind: 'view'; value: DesktopMcpSignInResponse }
    | { kind: 'continuation'; response: Response }

export async function desktopMcpSignInAction(sessionId: string, action: DesktopMcpSignInAction, request: DesktopMcpSignInDecision, options: { signal?: AbortSignal } = {}): Promise<DesktopMcpSignInActionResult> {
    const response = await fetch(url(sessionId), {
        method: 'POST', cache: 'no-store', signal: options.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, request: desktopMcpSignInDecisionSchema.parse(request) }),
    })
    if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(typeof body?.error === 'string' ? body.error : 'MCP sign-in acknowledgement is unavailable. Retry the saved decision.')
    }
    if (action === 'complete' || action === 'decline' || action === 'recover') {
        if (response.headers.get('x-mcp-sign-in-request-id') !== request.requestId || response.headers.get('x-session-id') !== sessionId || !response.headers.get('x-run-id')) {
            throw new Error('MCP sign-in acknowledgement belonged to another request.')
        }
        return { kind: 'continuation', response }
    }
    return { kind: 'view', value: desktopMcpSignInResponseSchema.parse(await response.json()) }
}
