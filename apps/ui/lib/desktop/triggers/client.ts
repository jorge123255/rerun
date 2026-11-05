'use client'

import { desktopTriggerSchema, desktopTriggerHistoryItemSchema, type DesktopTrigger, type DesktopTriggerCreate, type DesktopTriggerHistoryItem, type DesktopTriggerUpdate } from '@rerun/contracts'
import { z } from 'zod'

class TriggerRequestError extends Error {}

async function request(agentId: string, method: string, body?: unknown, query?: Record<string, string>) {
    const params = new URLSearchParams(query)
    const qs = params.size ? `?${params}` : ''
    let attemptKey: string | null = null
    if (body && typeof body === 'object') {
        const outer = body as Record<string, unknown>
        const source = outer.input && typeof outer.input === 'object' ? outer.input as Record<string, unknown> : outer
        if (typeof source.requestId === 'string') {
            const { requestId: _requestId, ...content } = source
            const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ method, query, slug: outer.slug, content })))
            attemptKey = `rerun.trigger.attempt:${agentId}:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`
            let saved: string | null = null
            try { saved = localStorage.getItem(attemptKey) } catch {}
            const id = saved && z.uuid().safeParse(saved).success ? saved : source.requestId
            try { localStorage.setItem(attemptKey, id) } catch {}
            body = outer.input ? { ...outer, input: { ...source, requestId: id } } : { ...source, requestId: id }
        }
    }
    const response = await fetch(`/api/desktop/coworkers/${encodeURIComponent(agentId)}/triggers${qs}`, {
        method,
        cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) {
        throw new TriggerRequestError(typeof result?.error === 'string' && result.error.trim() && result.error.length <= 500 ? result.error : 'Trigger request failed')
    }
    if (attemptKey) { try { localStorage.removeItem(attemptKey) } catch {} }
    return result
}

export { TriggerRequestError }

export async function listDesktopTriggers(agentId: string): Promise<DesktopTrigger[]> {
    const result = await request(agentId, 'GET')
    return z.array(desktopTriggerSchema).parse(result?.triggers)
}

export async function getDesktopTrigger(agentId: string, slug: string): Promise<DesktopTrigger> {
    return desktopTriggerSchema.parse(await request(agentId, 'GET', undefined, { slug }))
}

export async function createDesktopTrigger(agentId: string, input: DesktopTriggerCreate): Promise<DesktopTrigger> {
    return request(agentId, 'PUT', input)
}

export async function updateDesktopTrigger(agentId: string, slug: string, input: DesktopTriggerUpdate): Promise<DesktopTrigger> {
    return request(agentId, 'PUT', { slug, input })
}

export async function rotateDesktopTrigger(agentId: string, slug: string, requestId: string, expectedRevision: string): Promise<DesktopTrigger> {
    return request(agentId, 'POST', { action: 'rotate', slug, requestId, expectedRevision })
}

export async function deleteDesktopTrigger(agentId: string, slug: string, requestId: string, expectedRevision: string): Promise<{ deleted: string }> {
    return request(agentId, 'DELETE', { slug, requestId, expectedRevision })
}

export async function listDesktopTriggerHistory(agentId: string, slug?: string): Promise<DesktopTriggerHistoryItem[]> {
    return z.array(desktopTriggerHistoryItemSchema).parse(await request(agentId, 'GET', undefined, { action: 'history', ...(slug ? { slug } : {}) }))
}

export async function stopDesktopTriggerRun(agentId: string, body: { requestId: string; localSessionId: string; runId: string; expectedEventId?: string }) {
    return request(agentId, 'POST', { action: 'stop', ...body })
}
