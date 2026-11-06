'use client'

import type { InputDef } from '@/lib/services/manifest'
import type { DesktopServiceAccountResult, DesktopServiceAccountView } from '@rerun/contracts'

export type ServiceAccountMethod = {
    id: string
    label: string
    kind: 'oauth' | 'key' | 'stdio' | 'none' | 'managed' | 'composio' | 'app'
    recommended: boolean
    inputs: InputDef[]
    requiresSecrets: boolean
    availability: { id: string; supported: boolean; reason?: string }
}

export type ServiceAccountLibraryRow = {
    slug: string
    name: string
    category: string
    summary: string
    icon: string | null
    verified: boolean
    requiresSecrets: boolean
    setup: 'needs_config'
    setupReason: string
    installed: boolean
    installStatus: 'active' | 'needs_config' | 'needs_auth' | 'error' | null
    multiInstance: boolean
    addAccount: boolean
    authMethods: ServiceAccountMethod[]
    methodAvailability: Array<{ id: string; supported: boolean; reason?: string }>
}

export type ServiceAccountDetail = {
    slug: string
    name: string
    category: string
    summary: string
    description: string
    icon: string | null
    multiInstance: boolean
    authMethods: ServiceAccountMethod[]
    methodAvailability: Array<{ id: string; supported: boolean; reason?: string }>
    accounts: DesktopServiceAccountView[]
    localLimitations: string
}

type MutationResult = DesktopServiceAccountResult & { error?: string }

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]))
    }
    return value
}

async function fingerprint(value: unknown): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value))))
    return Array.from(new Uint8Array(bytes), item => item.toString(16).padStart(2, '0')).join('')
}

function remember(key: string, requestId: string) {
    try {
        globalThis.sessionStorage?.setItem(`desktop-service-account:${key}`, requestId)
    } catch {
        /* The in-memory id still covers this page. */
    }
}

function recall(key: string): string | null {
    try {
        return globalThis.sessionStorage?.getItem(`desktop-service-account:${key}`) ?? null
    } catch {
        return null
    }
}

function forget(key: string) {
    try {
        globalThis.sessionStorage?.removeItem(`desktop-service-account:${key}`)
    } catch {
        /* ignore */
    }
}

export function createDesktopServiceAccountsClient(coworkerId: string) {
    const url = `/api/desktop/coworkers/${encodeURIComponent(coworkerId)}/service-accounts`
    const requests = new Map<string, string>()
    const acknowledged = new Map<string, string>()
    const controllers = new Set<AbortController>()
    let closed = false
    async function request<T>(method: 'GET' | 'POST', body?: Record<string, unknown>, query?: URLSearchParams): Promise<T> {
        if (closed) throw new Error('Service panel owner changed')
        const controller = new AbortController()
        controllers.add(controller)
        try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(130_000)])
            const response = await fetch(method === 'GET' ? `${url}?${query}` : url, {
                method,
                cache: 'no-store',
                signal,
                headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
                body: method === 'GET' ? undefined : JSON.stringify(body),
            })
            const data = (await response.json()) as T & { error?: string }
            signal.throwIfAborted()
            if (closed) throw new Error('Service panel owner changed')
            if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Local service request unavailable or acknowledgement unknown. Refresh connection state.')
            return data
        } finally {
            controllers.delete(controller)
        }
    }
    async function mutate(action: string, payload: Record<string, unknown>, _reuse: 'keep' | 'probe'): Promise<DesktopServiceAccountResult> {
        if (closed) throw new Error('Service panel owner changed')
        const stamp = await fingerprint([coworkerId, action, payload])
        const afterRequestId = acknowledged.get(stamp) ?? recall(`${stamp}:ack`)
        let requestId = requests.get(stamp) ?? recall(stamp)
        if (!requestId || requestId === afterRequestId) {
            requestId = crypto.randomUUID()
            requests.set(stamp, requestId)
            remember(stamp, requestId)
        } else requests.set(stamp, requestId)
        const prepared = await request<{ requestId: string }>('POST', { action: 'prepare-attempt', mutation: { action, requestId, ...payload }, ...(afterRequestId ? { afterRequestId } : {}) })
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(prepared.requestId)) throw new Error('Account attempt identity unavailable')
        const attemptId = prepared.requestId
        requests.set(stamp, attemptId)
        remember(stamp, attemptId)
        const mutation = { action, requestId: attemptId, ...payload }
        const result = await request<MutationResult>('POST', mutation)
        const acknowledge = async () => {
            const receipt = await request<{ acknowledged: boolean; requestId: string }>('POST', { action: 'acknowledge-attempt', mutation })
            if (receipt.acknowledged !== true || receipt.requestId !== attemptId) throw new Error('Account acknowledgement unavailable')
            requests.delete(stamp)
            forget(stamp)
            acknowledged.set(stamp, attemptId)
            remember(`${stamp}:ack`, attemptId)
        }
        if (result.status === 'unknown') {
            // Only the server can distinguish a completed stale receipt from an
            // interrupted operation. Never rotate an uncertain write on our own.
            await acknowledge().catch(() => {})
            throw new Error(result.message ?? 'Prior request acknowledgement unavailable; inspect connection state.')
        }
        await acknowledge()
        return result
    }
    return {
        installed: () => request<DesktopServiceAccountView[]>('GET', undefined, new URLSearchParams({ view: 'installed' })),
        catalog: (query = '', category = '', offset = 0) => request<{ total: number; services: ServiceAccountLibraryRow[] }>('GET', undefined, new URLSearchParams({ view: 'catalog', query, ...(category ? { category } : {}), offset: String(offset), limit: '50' })),
        detail: (slug: string) => request<ServiceAccountDetail>('GET', undefined, new URLSearchParams({ view: 'detail', slug })),
        install: (slug: string, kind: 'new' | 'additional', authMethodId: string, values: Record<string, string>) => mutate('install', { intent: { kind, slug }, authMethodId, values }, 'keep'),
        reconfigure: (accountKey: string, expectedRevision: string, authMethodId: string, values: Record<string, string>) => mutate('reconfigure', { intent: { kind: 'existing', accountKey, expectedRevision }, authMethodId, values }, 'keep'),
        probe: (accountKey: string, expectedRevision: string) => mutate('probe', { intent: { kind: 'existing', accountKey, expectedRevision } }, 'probe'),
        disconnect: (accountKey: string, expectedRevision: string) => mutate('disconnect', { intent: { kind: 'existing', accountKey, expectedRevision } }, 'keep'),
        remove: (accountKey: string, expectedRevision: string) => mutate('remove', { intent: { kind: 'existing', accountKey, expectedRevision } }, 'keep'),
        dispose() {
            closed = true
            for (const controller of controllers) controller.abort()
            controllers.clear()
        },
    }
}

export type DesktopServiceAccountsClient = ReturnType<typeof createDesktopServiceAccountsClient>
