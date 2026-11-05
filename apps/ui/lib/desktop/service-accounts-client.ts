'use client'

import type { DesktopServiceAccountResult, DesktopServiceAccountView } from '../../../../packages/contracts/src/desktop-service-accounts'

export type ServiceAccountMethod = {
    id: string
    label: string
    kind: 'oauth' | 'key' | 'stdio' | 'none' | 'managed' | 'composio' | 'app'
    recommended: boolean
    inputs: Array<{ key: string; label: string; type?: string; secret?: boolean; required?: boolean; placeholder?: string; help?: string; guide?: string; options?: Array<{ value: string; label: string }> }>
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
    async function mutate(action: string, payload: Record<string, unknown>, reuse: 'keep' | 'probe'): Promise<DesktopServiceAccountResult> {
        const stamp = await fingerprint([action, payload])
        let requestId = requests.get(stamp) ?? recall(stamp)
        if (!requestId) {
            requestId = crypto.randomUUID()
            requests.set(stamp, requestId)
            remember(stamp, requestId)
        } else requests.set(stamp, requestId)
        const result = await request<MutationResult>('POST', { action, requestId, ...payload })
        if (result.status === 'unknown') {
            if (reuse === 'probe') {
                requests.delete(stamp)
                forget(stamp)
            }
            throw new Error(result.message ?? 'Prior request acknowledgement unavailable; inspect connection state.')
        }
        if (reuse === 'probe' || result.status === 'removed') {
            requests.delete(stamp)
            forget(stamp)
        }
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
