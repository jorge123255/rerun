'use client'

import { desktopSecretRequestActionSchema, desktopSecretRequestResponseSchema, type DesktopSecretRequestAction, type DesktopSecretRequestView } from '@rerun/contracts'

const url = (sessionId: string) => `/api/desktop/sessions/${encodeURIComponent(sessionId)}/secret-requests`

export async function readDesktopSecretRequest(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<DesktopSecretRequestView | null> {
    const response = await fetch(url(sessionId), { cache: 'no-store', signal: options.signal })
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Could not load the credential request.')
    return desktopSecretRequestResponseSchema.parse(body).request
}

export async function submitDesktopSecretRequestDecision(sessionId: string, input: DesktopSecretRequestAction, options: { signal?: AbortSignal } = {}): Promise<Response> {
    const response = await fetch(url(sessionId), {
        method: 'POST', cache: 'no-store', signal: options.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(desktopSecretRequestActionSchema.parse(input)),
    })
    if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(typeof body?.error === 'string' ? body.error : 'Credential decision acknowledgement is unknown. Retry the same decision.')
    }
    if (response.headers.get('x-secret-request-id') !== input.requestId || !response.headers.get('x-run-id') || response.headers.get('x-session-id') !== sessionId) {
        throw new Error('Credential decision acknowledgement belonged to another request.')
    }
    return response
}
