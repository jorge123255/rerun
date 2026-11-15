'use client'

import { desktopForemanIntakeCompletionReceiptSchema, desktopForemanIntakeViewSchema, isTemplateCategory, type DesktopForemanChatRef } from '@rerun/contracts'
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

/** Asks again while the typed answer is still being saved; the suggestion is made from the saved answer only. */
async function hinted(chat: DesktopForemanChatRef, action: 'decide-industry' | 'analyze-site', hint: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
        const response = await fetch('/api/desktop/foreman/intake', {
            method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, chat, hint: hint.trim() }),
        })
        const body: unknown = await response.json().catch(() => null)
        if (response.ok) return body
        if (response.status !== 409 || attempt >= 4 || !(body as { pending?: unknown } | null)?.pending) throw new Error('Company details could not be read.')
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 400)
            signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
        })
    }
}

/** With `chat`, the intake can suggest an industry and read the company website; without it every question is asked. */
export function createDesktopForemanIntakeClient(chat?: DesktopForemanChatRef): DesktopForemanIntakeClientPorts {
    return {
        read: async (chat, signal) => desktopForemanIntakeViewSchema.parse(await intakeRequest(chat, undefined, signal)),
        save: async (input, signal) => desktopForemanIntakeViewSchema.parse(await intakeRequest(input.chat, { action: 'save', input }, signal)),
        complete: async (input, signal) => desktopForemanIntakeCompletionReceiptSchema.parse(await intakeRequest(input.chat, { action: 'complete', input }, signal)),
        lookupCompletion: async (chat, requestId, signal) => {
            const body = await intakeRequest(chat, { action: 'lookup', chat, requestId }, signal) as { completion: unknown }
            return body.completion === null ? null : desktopForemanIntakeCompletionReceiptSchema.parse(body.completion)
        },
        ...(chat && {
            decideIndustry: async (input: string, signal?: AbortSignal) => {
                const industry = (await hinted(chat, 'decide-industry', input, 40_000, signal) as { industry?: unknown } | null)?.industry
                return typeof industry === 'string' && isTemplateCategory(industry) ? industry : null
            },
            analyzeSite: async (url: string, signal?: AbortSignal) => {
                const state = (await hinted(chat, 'analyze-site', url, 75_000, signal) as { state?: unknown } | null)?.state
                return { state: state === 'ready' || state === 'unavailable' ? state : 'failed' as const }
            },
        }),
    }
}
