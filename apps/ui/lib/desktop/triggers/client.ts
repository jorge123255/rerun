'use client'

import type { DesktopTrigger, DesktopTriggerCreate, DesktopTriggerHistoryItem, DesktopTriggerUpdate } from '@rerun/contracts'

class TriggerRequestError extends Error {}

async function request(agentId: string, method: string, body?: unknown, query?: Record<string, string>) {
    const params = new URLSearchParams(query)
    const qs = params.size ? `?${params}` : ''
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
    return result
}

export { TriggerRequestError }

export async function listDesktopTriggers(agentId: string): Promise<DesktopTrigger[]> {
    const result = await request(agentId, 'GET')
    return Array.isArray(result?.triggers) ? result.triggers : []
}

export async function getDesktopTrigger(agentId: string, slug: string): Promise<DesktopTrigger> {
    return request(agentId, 'GET', undefined, { slug })
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
    return request(agentId, 'GET', undefined, { action: 'history', ...(slug ? { slug } : {}) })
}

export async function stopDesktopTriggerRun(agentId: string, body: { requestId: string; localSessionId: string; runId: string; expectedEventId?: string }) {
    return request(agentId, 'POST', { action: 'stop', ...body })
}
