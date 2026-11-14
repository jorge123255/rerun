import 'server-only'

// Composio's API, called with the person's own project key. Composio brokers the sign-in to the
// app (Google, Microsoft and so on) and holds that sign-in; this Mac holds only the Composio key.
// The key travels in one header to one host and is never part of an error or a result.
export const COMPOSIO_API = 'https://backend.composio.dev/api/v3.1'
export type ManagedAppsFetch = typeof fetch

export class ManagedAppsError extends Error {
    constructor(readonly status: number, message: string) { super(message) }
}

export type ManagedTool = { slug: string; description: string; inputSchema: Record<string, unknown>; destructive: boolean }

export function managedAppsClient(key: string, network: ManagedAppsFetch = fetch, base = COMPOSIO_API) {
    async function call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
        let response: Response
        try {
            response = await network(base + path, {
                method: init.method ?? 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit',
                signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(60_000)]),
                headers: { 'x-api-key': key, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
                ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
            })
        } catch { throw new ManagedAppsError(503, 'Composio could not be reached. Check the connection and try again.') }
        if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new ManagedAppsError(401, 'Composio refused this key.') }
        if (!response.ok) { await response.body?.cancel(); throw new ManagedAppsError(502, `Composio answered ${response.status}.`) }
        const text = await response.text()
        if (text.length > 4_000_000) throw new ManagedAppsError(502, 'Composio sent too much data.')
        try { return JSON.parse(text) as T } catch { throw new ManagedAppsError(502, 'Composio sent an answer that could not be read.') }
    }
    return {
        /** A cheap call that only succeeds with a working key. */
        async check(signal?: AbortSignal) { await call('/auth_configs?limit=1', { signal }) },
        /** The Composio-managed sign-in for one app in this project, made if the project has none yet. */
        async authConfig(toolkit: string, signal?: AbortSignal): Promise<string> {
            const listed = await call<{ items?: { id?: string; status?: string; is_composio_managed?: boolean; toolkit?: { slug?: string } }[] }>(
                `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&is_composio_managed=true&limit=50`, { signal })
            const existing = listed.items?.find(row => row.id && row.status !== 'DISABLED' && row.is_composio_managed !== false && (row.toolkit?.slug ?? toolkit).toLowerCase() === toolkit.toLowerCase())
            if (existing?.id) return existing.id
            const made = await call<{ auth_config?: { id?: string } }>('/auth_configs', { method: 'POST', signal, body: { toolkit: { slug: toolkit }, auth_config: { type: 'use_composio_managed_auth', credentials: {} } } })
            if (!made.auth_config?.id) throw new ManagedAppsError(502, 'Composio did not set up the sign-in for this app.')
            return made.auth_config.id
        },
        async link(userId: string, authConfigId: string, callbackUrl: string, signal?: AbortSignal) {
            const data = await call<{ connected_account_id?: string; redirect_url?: string }>('/connected_accounts/link', { method: 'POST', signal, body: { auth_config_id: authConfigId, user_id: userId, callback_url: callbackUrl } })
            let redirect: URL | null = null
            try { redirect = new URL(data.redirect_url ?? '') } catch { /* refused below */ }
            if (!data.connected_account_id || redirect?.protocol !== 'https:') throw new ManagedAppsError(502, 'Composio did not return a sign-in page.')
            return { connectedAccountId: data.connected_account_id, redirectUrl: redirect.href }
        },
        async account(id: string, signal?: AbortSignal) {
            const data = await call<{ id?: string; user_id?: string; status?: string; toolkit?: { slug?: string } }>(`/connected_accounts/${encodeURIComponent(id)}`, { signal })
            return { userId: data.user_id ?? '', status: data.status ?? '', toolkit: data.toolkit?.slug ?? '' }
        },
        async remove(id: string, signal?: AbortSignal) { await call(`/connected_accounts/${encodeURIComponent(id)}`, { method: 'DELETE', signal }) },
        async tools(toolkit: string, signal?: AbortSignal): Promise<ManagedTool[]> {
            const tools: ManagedTool[] = []
            let cursor: string | null = null
            for (let page = 0; page < 20; page++) {
                const query = new URLSearchParams({ toolkit_slug: toolkit, limit: '200' })
                if (cursor) query.set('cursor', cursor)
                const data: { items?: { slug?: string; description?: string; input_parameters?: Record<string, unknown>; tags?: string[] }[]; next_cursor?: string | null } = await call(`/tools?${query}`, { signal })
                for (const row of data.items ?? []) {
                    if (!row.slug || !/^[\w.-]{1,128}$/.test(row.slug)) continue
                    const schema = row.input_parameters && row.input_parameters.type === 'object' ? row.input_parameters : { type: 'object', properties: {} }
                    tools.push({ slug: row.slug, description: (row.description ?? row.slug).slice(0, 8000), inputSchema: schema, destructive: (row.tags ?? []).some(tag => /destructive/i.test(tag)) })
                }
                cursor = data.next_cursor ?? null
                if (!cursor) break
            }
            return tools
        },
        async execute(tool: string, userId: string, args: Record<string, unknown>, signal?: AbortSignal) {
            const data = await call<{ successful?: boolean; data?: unknown; error?: string | null }>(`/tools/execute/${encodeURIComponent(tool)}`, { method: 'POST', signal, body: { user_id: userId, arguments: args } })
            return { successful: data.successful === true, data: data.data ?? null, error: typeof data.error === 'string' ? data.error : null }
        },
    }
}
