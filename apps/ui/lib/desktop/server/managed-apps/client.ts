import 'server-only'
import { connectionCapabilities, toolkitIsConnected } from './connect-capabilities'
import { boundedText, decodeReply, isMcpHttpVersion, preferredMcpHttpVersion } from '../mcp/remote'

// Composio's API, called with the person's own project key. Composio brokers the sign-in to the
// app (Google, Microsoft and so on) and holds that sign-in; this Mac holds only the Composio key.
// The key travels in one header to one host and is never part of an error or a result.
export const COMPOSIO_API = 'https://backend.composio.dev/api/v3.1'
export type ManagedAppsFetch = typeof fetch

export class ManagedAppsError extends Error {
    constructor(readonly status: number, message: string) { super(message) }
}

export type ManagedTool = { slug: string; description: string; inputSchema: Record<string, unknown>; destructive: boolean }

/** Composio issues a key for a project and a key for a person's account; each travels in its own header. */
export type ManagedAppsKeyKind = 'project' | 'account'
const KEY_HEADER: Record<ManagedAppsKeyKind, string> = { project: 'x-api-key', account: 'x-user-api-key' }

/** Tries the key the way each kind is sent and says which one Composio accepted. */
export async function managedAppsKeyKind(key: string, network: ManagedAppsFetch = fetch, signal?: AbortSignal): Promise<ManagedAppsKeyKind> {
    let refusal: ManagedAppsError | null = null
    for (const kind of ['project', 'account'] as const) {
        try { await managedAppsClient(key, network, COMPOSIO_API, kind).check(signal); return kind }
        catch (error) {
            if (!(error instanceof ManagedAppsError) || (error.status !== 401 && error.status !== 403)) throw error
            refusal ??= error
        }
    }
    throw refusal ?? new ManagedAppsError(401, 'Composio refused this key.')
}

/** Composio Connect: one MCP address that reaches every app, opened with a consumer key in its own header. */
export const COMPOSIO_CONNECT = 'https://connect.composio.dev/mcp'
export const COMPOSIO_CONNECT_HEADER = 'x-consumer-api-key'

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: preferredMcpHttpVersion, capabilities: {}, clientInfo: { name: 'rerun-desktop', version: '1.0.0' } } }

async function connectReply(response: Response, id: number, signal: AbortSignal): Promise<Record<string, unknown>> {
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (mime !== 'application/json' && mime !== 'text/event-stream') {
        await response.body?.cancel()
        throw new ManagedAppsError(502, 'Composio sent an answer that could not be read.')
    }
    try {
        const text = await boundedText(response, signal, 4_000_000, mime === 'text/event-stream' ? id : undefined)
        return decodeReply(text, mime, id)
    } catch {
        signal.throwIfAborted()
        throw new ManagedAppsError(502, 'Composio did not confirm the request.')
    }
}

async function confirmInitialize(response: Response, signal: AbortSignal) {
    const result = await connectReply(response, initialize.id, signal)
    if (!isMcpHttpVersion(result.protocolVersion)) throw new ManagedAppsError(502, 'Composio did not confirm a compatible connection.')
    return result.protocolVersion
}

/** Whether Composio Connect accepts this key. Nothing but the handshake is sent. */
export async function managedAppsConnectAccepts(key: string, network: ManagedAppsFetch = fetch, signal?: AbortSignal): Promise<boolean> {
    const stop = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)])
    let response: Response
    try {
        response = await network(COMPOSIO_CONNECT, {
            method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
            signal: stop,
            headers: { [COMPOSIO_CONNECT_HEADER]: key, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify(initialize),
        })
    } catch { throw new ManagedAppsError(503, 'Composio could not be reached. Check the connection and try again.') }
    if (response.ok) { await confirmInitialize(response, stop); return true }
    await response.body?.cancel()
    if (response.status === 401 || response.status === 403) return false
    throw new ManagedAppsError(502, `Composio answered ${response.status}.`)
}

function httpsPicture(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 700) return null
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null }
}

/** What an app's own API answered through Composio: its HTTP status and its data. */
export type ManagedProxyAnswer = { status: number; data: unknown }

/**
 * Reads the app's answer out of what Composio returned for a proxied request. Composio wraps it a
 * level or two deep depending on the door used, so the first object carrying an HTTP status beside
 * the app's data is taken. Anything else is not an answer.
 */
export function managedProxyAnswer(value: unknown, depth = 0): ManagedProxyAnswer | null {
    if (depth > 3 || !value || typeof value !== 'object' || Array.isArray(value)) return null
    const row = value as Record<string, unknown>
    const status = typeof row.status === 'number' ? row.status : typeof row.status_code === 'number' ? row.status_code : null
    if (status !== null && Number.isInteger(status) && status >= 100 && status <= 599 && ('data' in row || 'body' in row)) return { status, data: 'data' in row ? row.data : row.body }
    for (const name of ['data', 'response', 'result']) {
        const found = managedProxyAnswer(row[name], depth + 1)
        if (found) return found
    }
    return null
}
// Only a plain read of one path is ever proxied: no query, no fragment, no other host.
const PROXY_PATH = /^\/[A-Za-z0-9._~%\/-]{1,600}$/

export function managedAppsClient(key: string, network: ManagedAppsFetch = fetch, base = COMPOSIO_API, kind: ManagedAppsKeyKind = 'project') {
    async function call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
        let response: Response
        try {
            response = await network(base + path, {
                method: init.method ?? 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit',
                signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(60_000)]),
                headers: { [KEY_HEADER[kind]]: key, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
                ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
            })
        } catch { throw new ManagedAppsError(503, 'Composio could not be reached. Check the connection and try again.') }
        if (response.status === 401) { await response.body?.cancel(); throw new ManagedAppsError(401, 'Composio did not recognize this key. Copy the API key from your Composio project’s settings and paste it again.') }
        if (response.status === 403) { await response.body?.cancel(); throw new ManagedAppsError(403, 'Composio recognized this key but it is not allowed to do this. Use the API key of the project you want to use, not an organization key.') }
        // Told apart from the other refusals: an account Composio no longer has is gone, not out of reach.
        if (response.status === 404) { await response.body?.cancel(); throw new ManagedAppsError(404, 'Composio no longer has this.') }
        if (!response.ok) { await response.body?.cancel(); throw new ManagedAppsError(502, `Composio answered ${response.status}.`) }
        const text = await response.text()
        if (text.length > 4_000_000) throw new ManagedAppsError(502, 'Composio sent too much data.')
        try { return JSON.parse(text) as T } catch { throw new ManagedAppsError(502, 'Composio sent an answer that could not be read.') }
    }
    return {
        /** A cheap call that only succeeds with a working key. */
        async check(signal?: AbortSignal) { await call('/toolkits?limit=1', { signal }) },
        /**
         * The sign-in set up for one app in this project. One the person made in their Composio
         * dashboard is used as it is; otherwise Composio's own ready-made sign-in is set up, where
         * Composio has one for the app.
         */
        async authConfig(toolkit: string, signal?: AbortSignal): Promise<string> {
            const listed = await call<{ items?: { id?: string; status?: string; toolkit?: { slug?: string } }[] }>(
                `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&limit=50`, { signal })
            const existing = listed.items?.find(row => row.id && row.status !== 'DISABLED' && (row.toolkit?.slug ?? toolkit).toLowerCase() === toolkit.toLowerCase())
            if (existing?.id) return existing.id
            let made: { auth_config?: { id?: string } }
            try { made = await call('/auth_configs', { method: 'POST', signal, body: { toolkit: { slug: toolkit }, auth_config: { type: 'use_composio_managed_auth', credentials: {} } } }) }
            catch (error) {
                if (error instanceof ManagedAppsError && (error.status === 502 || error.status === 404)) throw new ManagedAppsError(409, 'Composio has no ready-made sign-in for this app. Set one up for it in your Composio dashboard, then press Connect again.')
                throw error
            }
            if (!made.auth_config?.id) throw new ManagedAppsError(502, 'Composio did not set up the sign-in for this app.')
            return made.auth_config.id
        },
        /** Every app this project can use, most used first. */
        async toolkits(signal?: AbortSignal): Promise<{ slug: string; name: string; summary: string; logo: string | null; noAuth: boolean; managed: boolean }[]> {
            const rows: { slug: string; name: string; summary: string; logo: string | null; noAuth: boolean; managed: boolean }[] = []
            let cursor: string | null = null
            for (let page = 0; page < 10; page++) {
                const query = new URLSearchParams({ sort_by: 'usage', limit: '1000' })
                if (cursor) query.set('cursor', cursor)
                const data: { items?: { slug?: string; name?: string; no_auth?: boolean; composio_managed_auth_schemes?: string[]; deprecated?: unknown; meta?: { description?: string; logo?: string } }[]; next_cursor?: string | null } = await call(`/toolkits?${query}`, { signal })
                for (const row of data.items ?? []) {
                    const slug = (row.slug ?? '').toLowerCase()
                    if (!/^[a-z0-9_-]{1,128}$/.test(slug) || rows.some(known => known.slug === slug)) continue
                    rows.push({ slug, name: (row.name ?? slug).slice(0, 200), summary: (row.meta?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 600), logo: httpsPicture(row.meta?.logo), noAuth: row.no_auth === true, managed: (row.composio_managed_auth_schemes ?? []).length > 0 })
                }
                cursor = data.next_cursor ?? null
                if (!cursor || rows.length >= 5000) break
            }
            return rows.slice(0, 5000)
        },
        async link(userId: string, authConfigId: string, callbackUrl: string, signal?: AbortSignal) {
            const data = await call<{ connected_account_id?: string; redirect_url?: string }>('/connected_accounts/link', { method: 'POST', signal, body: { auth_config_id: authConfigId, user_id: userId, callback_url: callbackUrl } })
            let redirect: URL | null = null
            try { redirect = new URL(data.redirect_url ?? '') } catch { /* refused below */ }
            if (!data.connected_account_id || redirect?.protocol !== 'https:') throw new ManagedAppsError(502, 'Composio did not return a sign-in page.')
            return { connectedAccountId: data.connected_account_id, redirectUrl: redirect.href }
        },
        async account(id: string, signal?: AbortSignal) {
            const data = await call<{ id?: string; user_id?: string; status?: string; is_disabled?: boolean; toolkit?: { slug?: string } }>(`/connected_accounts/${encodeURIComponent(id)}`, { signal })
            return { id: data.id, userId: data.user_id, status: data.is_disabled === true ? 'INACTIVE' : data.status ?? '', toolkit: typeof data.toolkit?.slug === 'string' ? data.toolkit.slug : '' }
        },
        async remove(id: string, signal?: AbortSignal) {
            const result = await call<{ success?: boolean } | null>(`/connected_accounts/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
            if (result?.success !== true) throw new ManagedAppsError(502, 'Composio did not confirm removal of this sign-in. Try again.')
        },
        /** An app's tools; `important` asks Composio for the ones it features, which keeps a large app usable. */
        async tools(toolkit: string, signal?: AbortSignal, important = false): Promise<ManagedTool[]> {
            const tools: ManagedTool[] = []
            let cursor: string | null = null
            for (let page = 0; page < 20; page++) {
                const query = new URLSearchParams({ toolkit_slug: toolkit, limit: '200' })
                if (important) query.set('important', 'true')
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
        async execute(tool: string, userId: string, connectedAccountId: string, args: Record<string, unknown>, signal?: AbortSignal) {
            const data = await call<{ successful?: boolean; data?: unknown; error?: string | null }>(`/tools/execute/${encodeURIComponent(tool)}`, { method: 'POST', signal, body: { user_id: userId, ...(connectedAccountId && { connected_account_id: connectedAccountId }), arguments: args } })
            return { successful: data.successful === true, data: data.data ?? null, error: typeof data.error === 'string' ? data.error : null }
        },
        /** A GET of one path of the app's own API, signed by Composio with one connected account. Nothing is changed there. */
        async proxyGet(connectedAccountId: string, path: string, signal?: AbortSignal): Promise<ManagedProxyAnswer> {
            if (!PROXY_PATH.test(path)) throw new ManagedAppsError(400, 'This path cannot be read.')
            const answer = managedProxyAnswer(await call('/tools/execute/proxy', { method: 'POST', signal, body: { connected_account_id: connectedAccountId, endpoint: path, method: 'GET' } }))
            if (!answer) throw new ManagedAppsError(502, 'Composio sent an answer that could not be read.')
            return answer
        },
    }
}

export type ManagedConnection = { state: 'active' | 'pending'; signIn?: string; accountIds: string[] }

function signInPage(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 2000) return
    try {
        const url = new URL(value)
        if (url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'composio.dev' || url.hostname.endsWith('.composio.dev'))) return url.href
    } catch { /* malformed redirect */ }
}

/** What Composio said about one app's connection: signed in, or waiting on the sign-in page it gave. */
export function managedConnectionOf(data: unknown, toolkit: string): ManagedConnection {
    const results = (data as { results?: Record<string, unknown> } | null)?.results
    const row = (results && typeof results === 'object' ? (results as Record<string, unknown>)[toolkit] ?? Object.values(results).find(entry => (entry as { toolkit?: unknown } | null)?.toolkit === toolkit) : null) as
        { toolkit?: unknown; status?: unknown; redirect_url?: unknown; has_active_connection?: unknown; accounts?: unknown } | null
    if (!row || typeof row !== 'object' || (row.toolkit !== undefined && row.toolkit !== toolkit)) throw new ManagedAppsError(502, 'Composio did not answer for this app.')
    if (row.status === 'failed') throw new ManagedAppsError(502, 'Composio could not do this for the app. Try again.')
    const live = (value: unknown) => typeof value === 'string' && /^(active|connected)$/i.test(value)
    const accounts = Array.isArray(row.accounts) ? row.accounts as { id?: unknown; status?: unknown }[] : []
    const accountIds = accounts.flatMap(account => typeof account?.id === 'string' && /^[\w.:-]{1,200}$/.test(account.id) ? [account.id] : [])
    if (live(row.status) || row.has_active_connection === true || accounts.some(account => live(account?.status))) return { state: 'active', accountIds }
    const signIn = signInPage(row.redirect_url)
    return { state: 'pending', accountIds, ...(signIn ? { signIn } : {}) }
}

// A removal is answered per app like everything else; only a stated failure stops it.
function managedConnectionOfRemoval(data: unknown, toolkit: string) {
    const row = (data as { results?: Record<string, { status?: unknown } | undefined> } | null)?.results?.[toolkit]
    if (!row || row.status === 'failed') throw new ManagedAppsError(502, 'Composio could not sign this app out. Remove it in your Composio account, then remove it here.')
}

/**
 * Composio Connect spoken to directly: the app asks it to start or look up one app's connection,
 * the same call a coworker would make. The consumer key travels in its one header to its one host.
 */
export function managedAppsConnectClient(key: string, network: ManagedAppsFetch = fetch, base = COMPOSIO_CONNECT) {
    let protocolVersion = preferredMcpHttpVersion
    async function post(body: unknown, session: string | null, signal: AbortSignal) {
        let response: Response
        try {
            response = await network(base, {
                method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
                signal,
                headers: { [COMPOSIO_CONNECT_HEADER]: key, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocolVersion, ...(session ? { 'mcp-session-id': session } : {}) },
                body: JSON.stringify(body),
            })
        } catch { throw new ManagedAppsError(503, 'Composio could not be reached. Check the connection and try again.') }
        if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new ManagedAppsError(401, 'Composio refused the key kept in the Vault. Open “composio” in the Vault and replace its key.') }
        if (!response.ok) { await response.body?.cancel(); throw new ManagedAppsError(502, `Composio answered ${response.status}.`) }
        return response
    }
    // One handshake serves every call this client makes.
    let opening: Promise<string | null> | null = null, next = 2
    async function open(signal: AbortSignal) {
        const opened = await post(initialize, null, signal)
        const session = opened.headers.get('mcp-session-id')
        protocolVersion = await confirmInitialize(opened, signal)
        await (await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session, signal)).body?.cancel()
        return session
    }
    async function rpc(method: string, params: unknown, signal?: AbortSignal) {
        const stop = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)])
        const session = await (opening ??= open(stop).catch(error => { opening = null; throw error }))
        const id = next++
        return connectReply(await post({ jsonrpc: '2.0', id, method, params }, session, stop), id, stop)
    }
    async function call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
        const result = await rpc('tools/call', { name: tool, arguments: args }, signal)
        if (result.isError === true) throw new ManagedAppsError(502, 'Composio could not do this now. Try again.')
        let payload: unknown = result.structuredContent
        if (payload === undefined) {
            const text = Array.isArray(result.content) && result.content.find(part => part?.type === 'text' && typeof part.text === 'string')?.text
            try { payload = JSON.parse(text) } catch { throw new ManagedAppsError(502, 'Composio sent an answer that could not be read.') }
        }
        const parsed = payload as { successful?: unknown; data?: unknown } | null
        if (parsed?.successful !== true) throw new ManagedAppsError(502, 'Composio could not do this now. Try again.')
        return parsed.data
    }
    const manage = 'COMPOSIO_MANAGE_CONNECTIONS', search = 'COMPOSIO_SEARCH_TOOLS'
    async function listCapabilities(signal?: AbortSignal) {
        let cursor: string | undefined, management: unknown, canSearch = false
        const seen = new Set<string>()
        for (let page = 0; page < 8; page++) {
            const listed = await rpc('tools/list', cursor ? { cursor } : {}, signal)
            if (!Array.isArray(listed.tools)) throw new ManagedAppsError(502, 'Composio did not list its connection tools.')
            for (const tool of listed.tools) {
                if (tool?.name === manage) management = tool.inputSchema
                if (tool?.name === search) canSearch = true
            }
            if (listed.nextCursor === undefined || listed.nextCursor === null || listed.nextCursor === '') {
                return { ...connectionCapabilities(management), canSearch }
            }
            if (typeof listed.nextCursor !== 'string' || seen.has(listed.nextCursor)) break
            cursor = listed.nextCursor
            seen.add(cursor)
        }
        throw new ManagedAppsError(502, 'Composio did not finish listing its connection tools.')
    }
    let listed: ReturnType<typeof listCapabilities> | undefined
    const capabilities = (signal?: AbortSignal) => listed ??= listCapabilities(signal).catch(error => { listed = undefined; throw error })
    return {
        /** A GET of one path of the app's own API, signed by Composio with the account signed in for that app. Nothing is changed there. */
        async proxyGet(toolkit: string, path: string, signal?: AbortSignal): Promise<ManagedProxyAnswer> {
            if (!PROXY_PATH.test(path)) throw new ManagedAppsError(400, 'This path cannot be read.')
            const answer = managedProxyAnswer(await call('COMPOSIO_PROXY_EXECUTE', { toolkit_slug: toolkit, endpoint: path, method: 'GET' }, signal))
            if (!answer) throw new ManagedAppsError(502, 'Composio sent an answer that could not be read.')
            return answer
        },
        /** An explicit Connect is the only operation allowed to start a sign-in. */
        async connect(toolkit: string, signal?: AbortSignal, intent: 'start' | 'renew' = 'start') {
            const cap = await capabilities(signal)
            const toolkits = cap.actions.has('add') ? [{ name: toolkit, action: 'add' }] : cap.slugs ? [toolkit] : null
            if (!toolkits) throw new ManagedAppsError(409, 'This Composio connection does not offer app sign-in.')
            // The action form starts a new link with add; the slug form needs its explicit renewal flag.
            const renewSlug = intent === 'renew' && !cap.actions.has('add')
            if (renewSlug && !cap.canRenew) throw new ManagedAppsError(409, 'This Composio connection does not offer a fresh sign-in link.')
            return managedConnectionOf(await call(manage, { toolkits, ...(renewSlug ? { reinitiate_all: true } : {}) }, signal), toolkit)
        },
        async status(toolkit: string, signal?: AbortSignal): Promise<ManagedConnection> {
            const cap = await capabilities(signal)
            if (cap.actions.has('list')) return managedConnectionOf(await call(manage, { toolkits: [{ name: toolkit, action: 'list' }] }, signal), toolkit)
            // The slug form of Manage initiates missing connections. Check the read-only Search result instead.
            if (!cap.canSearch) throw new ManagedAppsError(409, 'This Composio connection cannot check sign-in without opening a new login.')
            const data = await call(search, { queries: [{ use_case: `Check the connection status for ${toolkit}.` }], session: { generate_id: true } }, signal)
            const active = toolkitIsConnected(data, toolkit)
            if (active === undefined) throw new ManagedAppsError(502, 'Composio did not confirm the sign-in status for this app.')
            return { state: active ? 'active' : 'pending', accountIds: [] }
        },
        /** Never initiate missing logins during bulk discovery. */
        async signedIn(toolkits: readonly string[], signal?: AbortSignal): Promise<string[]> {
            if (!(await capabilities(signal)).actions.has('list')) throw new ManagedAppsError(409, 'This Composio connection cannot list signed-in apps in bulk. Select an app in the catalog to connect it, or check an existing sign-in.')
            const found: string[] = []
            for (let start = 0; start < toolkits.length; start += 50) {
                const batch = toolkits.slice(start, start + 50)
                const data = await call(manage, { toolkits: batch.map(name => ({ name, action: 'list' })) }, signal)
                for (const toolkit of batch) { try { if (managedConnectionOf(data, toolkit).state === 'active') found.push(toolkit) } catch { /* not answered */ } }
            }
            return found
        },
        /** Signs one app out at Composio: every account it holds for the app is removed, and Composio is asked again to be sure. */
        async remove(toolkit: string, signal?: AbortSignal) {
            const cap = await capabilities(signal)
            const held = await this.status(toolkit, signal)
            if ((held.state === 'active' && !held.accountIds.length) || (held.accountIds.length && !cap.actions.has('remove'))) {
                throw new ManagedAppsError(409, 'Disconnect the app in your Composio account, then remove it here.')
            }
            for (const account of held.accountIds) managedConnectionOfRemoval(await call(manage, { toolkits: [{ name: toolkit, action: 'remove', account_id: account }] }, signal), toolkit)
            if (held.accountIds.length && (await this.status(toolkit, signal)).state === 'active') throw new ManagedAppsError(502, 'Composio still shows this app signed in. Remove it in your Composio account, then remove it here.')
        },
    }
}
export type ManagedAppsConnect = ReturnType<typeof managedAppsConnectClient>
