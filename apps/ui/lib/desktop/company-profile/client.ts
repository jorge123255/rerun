'use client'

import {
    desktopCompanyProfileAttemptSchema,
    desktopCompanyProfileViewSchema,
    type DesktopCompanyProfileAttempt,
    type DesktopCompanyProfileCancelInput,
    type DesktopCompanyProfileDecideInput,
    type DesktopCompanyProfileEnrichInput,
    type DesktopCompanyProfileView,
    type DesktopForemanChatRef,
} from '@rerun/contracts'

const ENDPOINT = '/api/desktop/foreman/company-profile'

export class DesktopCompanyProfileRequestError extends Error {
    constructor(message: string, readonly status: number | null) {
        super(message)
        this.name = 'DesktopCompanyProfileRequestError'
    }
}

async function request(input: {
    action?: 'decide' | 'enrich' | 'cancel'
    body?: unknown
    query?: DesktopForemanChatRef
    signal?: AbortSignal
    timeoutMs?: number
}): Promise<unknown> {
    const { action, body, query, signal, timeoutMs = 20_000 } = input
    const url = action ? ENDPOINT : `${ENDPOINT}?${new URLSearchParams(query!)}`
    let response: Response
    try {
        response = await fetch(url, {
            method: action ? 'POST' : 'GET',
            cache: 'no-store',
            redirect: 'error',
            signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
            ...(action ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, input: body }) } : {}),
        })
    } catch (error) {
        throw new DesktopCompanyProfileRequestError(error instanceof Error ? error.message : 'Company profile could not be reached.', null)
    }
    const data = await response.json().catch(() => null)
    if (!response.ok) {
        throw new DesktopCompanyProfileRequestError(data && typeof data.error === 'string' ? data.error : 'Company profile request was refused.', response.status)
    }
    return data
}

export function createDesktopCompanyProfileClient() {
    return {
        async read(chat: DesktopForemanChatRef, signal?: AbortSignal): Promise<DesktopCompanyProfileView> {
            return desktopCompanyProfileViewSchema.parse(await request({ query: chat, signal }))
        },
        async decide(input: DesktopCompanyProfileDecideInput, signal?: AbortSignal): Promise<DesktopCompanyProfileAttempt> {
            return desktopCompanyProfileAttemptSchema.parse(await request({ action: 'decide', body: input, signal, timeoutMs: 45_000 }))
        },
        async enrich(input: DesktopCompanyProfileEnrichInput, signal?: AbortSignal): Promise<DesktopCompanyProfileAttempt> {
            return desktopCompanyProfileAttemptSchema.parse(await request({ action: 'enrich', body: input, signal, timeoutMs: 125_000 }))
        },
        async cancel(input: DesktopCompanyProfileCancelInput, signal?: AbortSignal): Promise<DesktopCompanyProfileAttempt> {
            return desktopCompanyProfileAttemptSchema.parse(await request({ action: 'cancel', body: input, signal, timeoutMs: 30_000 }))
        },
    }
}

export type DesktopCompanyProfileClient = ReturnType<typeof createDesktopCompanyProfileClient>
