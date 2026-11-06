'use client'

import { z } from 'zod'
import {
    externalMcpCreateResultSchema,
    externalMcpListResponseSchema,
    externalMcpListenerResultSchema,
    externalMcpListenerViewSchema,
    externalMcpRevokeResultSchema,
} from '@rerun/contracts'
import { desktopExternalMcpAttemptListSchema, desktopExternalMcpAttemptSchema } from './attempts'
import type { DesktopExternalMcpDriver } from './driver'

async function request<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal,
    })
    const text = await response.text()
    if (text.length > 1_000_000) throw new Error('External-client response is too large.')
    const result = schema.safeParse(text ? JSON.parse(text) : null)
    if (!result.success) throw new Error('External-client acknowledgement could not be read.')
    if (!response.ok && (!result.data || typeof result.data !== 'object' || !('ok' in result.data) || result.data.ok !== false)) throw new Error('External-client request was not confirmed.')
    signal.throwIfAborted()
    return result.data
}

export function createDesktopExternalMcpDriver(workspaceId: number): DesktopExternalMcpDriver {
    const base = '/api/desktop/external-mcp'
    return {
        async list(id, signal) {
            if (id !== workspaceId) throw new Error('External-client workspace changed.')
            const result = await request(`${base}/keys?workspaceId=${id}`, externalMcpListResponseSchema, signal)
            if ('ok' in result) throw new Error(result.message)
            if (result.workspaceId !== id || result.keys.some(key => key.workspaceId !== id)) throw new Error('External-client workspace changed.')
            return result
        },
        async listener(signal) {
            const result = await request(`${base}/listener`, externalMcpListenerViewSchema, signal)
            if (result.workspaceId !== null && result.workspaceId !== workspaceId) throw new Error('External-client workspace changed.')
            return result
        },
        create: (input, signal) => request(`${base}/keys`, externalMcpCreateResultSchema, signal, 'POST', input),
        revoke: (input, signal) => request(`${base}/keys/revoke`, externalMcpRevokeResultSchema, signal, 'POST', input),
        enable: (input, signal) => request(`${base}/listener/enable`, externalMcpListenerResultSchema, signal, 'POST', input),
        disable: (input, signal) => request(`${base}/listener/disable`, externalMcpListenerResultSchema, signal, 'POST', input),
        attempts: {
            list: async (id, signal) => {
                if (id !== workspaceId) throw new Error('External-client workspace changed.')
                const result = await request(`${base}/attempts?workspaceId=${id}`, z.strictObject({ attempts: desktopExternalMcpAttemptListSchema }), signal)
                return result.attempts.filter(attempt => attempt.input.workspaceId === id)
            },
            reserve: async (attempt, signal) => {
                const result = await request(`${base}/attempts`, z.strictObject({ attempt: desktopExternalMcpAttemptSchema }), signal, 'PUT', attempt)
                return result.attempt
            },
            clear: async (attempt, signal) => {
                await request(`${base}/attempts`, z.strictObject({ attempt: z.null() }), signal, 'DELETE', attempt)
            },
        },
    }
}
