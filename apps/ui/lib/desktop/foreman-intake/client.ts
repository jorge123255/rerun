'use client'

import { desktopForemanIntakeCompletionReceiptSchema, desktopForemanIntakeViewSchema, type DesktopForemanChatRef } from '@rerun/contracts'
import { DesktopForemanIntakeClientConflictError, type DesktopForemanIntakeClientPorts } from './ports'

async function intakeRequest(chat: DesktopForemanChatRef, action?: Record<string, unknown>, signal?: AbortSignal) {
    const response = await fetch(`/api/desktop/foreman/intake${action ? '' : `?${new URLSearchParams(chat)}`}`, {
        method: action ? 'POST' : 'GET', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
        ...(action ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) } : {}),
    })
    const body: unknown = await response.json()
    if (!response.ok) {
        const value = body as { error?: unknown; view?: unknown }
        const message = typeof value?.error === 'string' ? value.error : 'Company details could not be saved. Retry the same action.'
        const view = desktopForemanIntakeViewSchema.safeParse(value?.view)
        if (response.status === 409 && view.success) throw new DesktopForemanIntakeClientConflictError(view.data, message)
        throw new Error(message)
    }
    return body
}

export function createDesktopForemanIntakeClient(): DesktopForemanIntakeClientPorts {
    return {
        read: async (chat, signal) => desktopForemanIntakeViewSchema.parse(await intakeRequest(chat, undefined, signal)),
        save: async (input, signal) => desktopForemanIntakeViewSchema.parse(await intakeRequest(input.chat, { action: 'save', input }, signal)),
        complete: async (input, signal) => desktopForemanIntakeCompletionReceiptSchema.parse(await intakeRequest(input.chat, { action: 'complete', input }, signal)),
        lookupCompletion: async (chat, requestId, signal) => {
            const body = await intakeRequest(chat, { action: 'lookup', chat, requestId }, signal) as { completion: unknown }
            return body.completion === null ? null : desktopForemanIntakeCompletionReceiptSchema.parse(body.completion)
        },
    }
}
