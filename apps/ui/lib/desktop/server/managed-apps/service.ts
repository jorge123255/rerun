import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { DesktopManagedAppsAction, DesktopManagedAppsResult, DesktopManagedAppsView } from '@rerun/contracts'
import bundledCatalog from '../services/catalog/bundled-services.json'
import composioApps from './composio-apps.json'
import type { DesktopSecretCrypto } from '../secret-requests/crypto'
import { COMPOSIO_API, managedAppsClient, managedAppsKeyKind, ManagedAppsError, type ManagedAppsConnect, type ManagedAppsFetch, type ManagedAppsKeyKind } from './client'

type CatalogApp = { slug: string; name: string; summary: string; toolkit: string; allowedTools: readonly string[] }
type BundledService = { slug?: string; name?: string; summary?: string; icon?: string | null; manifest?: { authMethods?: { kind?: string; composio?: { toolkit?: string; allowedTools?: string[] } }[] } }

/** The apps of the bundled catalog whose only sign-in is a managed one. */
export const managedAppCatalog: readonly CatalogApp[] = ((bundledCatalog as { services: BundledService[] }).services).flatMap(service => {
    const method = service.manifest?.authMethods?.find(row => row.kind === 'composio' && row.composio?.toolkit)
    if (!service.slug || !method?.composio?.toolkit) return []
    return [{ slug: service.slug, name: service.name ?? service.slug, summary: (service.summary ?? '').slice(0, 600), toolkit: method.composio.toolkit, allowedTools: method.composio.allowedTools ?? [] }]
}).sort((a, b) => a.name.localeCompare(b.name))

/** The most tools one app gives a coworker. A model step carries a bounded number of tools, and some apps have hundreds. */
export const MANAGED_APP_TOOL_LIMIT = 40
// The apps a Composio project offers change rarely: one listing per key serves for six hours.
type OfferedApp = { slug: string; name: string; summary: string; logo?: string; noAuth: boolean }
const appCache = new Map<string, { at: number; apps: OfferedApp[] }>()
// The artwork this app ships, by the name Composio knows the app by and by its catalog name with the punctuation dropped.
const bundledLogos = new Map<string, string>()
for (const service of (bundledCatalog as { services: BundledService[] }).services) {
    if (!service.slug || !service.icon) continue
    const toolkit = service.manifest?.authMethods?.find(row => row.composio?.toolkit)?.composio?.toolkit
    for (const name of [service.slug, toolkit]) if (name) bundledLogos.set(name.toLowerCase().replace(/[-_]/g, ''), service.icon)
}
/** Bundled artwork first: it is on the Mac already and matches the rest of the catalog. */
export const managedAppLogo = (slug: string, remote?: string | null) => bundledLogos.get(slug.toLowerCase().replace(/[-_]/g, '')) ?? remote ?? undefined
/** How many of the most used apps are asked about when looking for ones already signed in. */
export const MANAGED_APP_FIND_LIMIT = 300
/** The name the Vault keeps a Composio Connect key under. */
export const COMPOSIO_CONNECT_NAME = 'composio'
// Every app Composio lists publicly, by its name there, most used first. With a Connect key the
// person's account cannot be asked for its list, so this one is shown.
const connectApps: OfferedApp[] = (composioApps as [string, string][]).map(([slug, name]) => ({
    slug, name, summary: managedAppCatalog.find(app => app.toolkit.toLowerCase() === slug)?.summary ?? '', logo: managedAppLogo(slug, `https://logos.composio.dev/api/${slug}`), noAuth: false,
}))
// What each app offers changes rarely; one listing serves every coworker for ten minutes.
const toolCache = new Map<string, { at: number; tools: Awaited<ReturnType<ReturnType<typeof managedAppsClient>['tools']>> }>()
const sealContext = (workspaceId: number, revision: string) => ({ domain: 'vault' as const, agentId: 'managed-apps', key: 'composio-key', version: 1, workspaceId, revision })
type Account = { id: string; slug: string; toolkit: string; name: string; userId: string; connectedAccountId: string; status: 'pending' | 'active' }
type ToolDefinition = {
    name: string; description: string; inputSchema: Record<string, unknown>; destructive: boolean
    execute(args: Record<string, unknown>, signal: AbortSignal, toolCallId: string): Promise<{ source: 'remote_mcp'; untrusted: true; result: Record<string, unknown> }>
}

export function desktopManagedApps(db: Client, crypto: DesktopSecretCrypto, workspaceId: number, options: {
    network?: ManagedAppsFetch; returnUrl: string; coworkerExists(agentId: string): Promise<boolean>
    /** Composio Connect opened with the key the Vault keeps as its “composio” connector, or null when there is none. */
    connect?: () => Promise<ManagedAppsConnect | null>
}) {
    const hasKey = async () => (await db.execute('SELECT 1 FROM desktop_managed_app_key WHERE id=1')).rows.length === 1
    /** Connect is used only while no project key is kept: a project key lists and runs the apps itself. */
    const connectMode = async () => !await hasKey() && options.connect ? await options.connect() : null
    // The sealed value is the key and which kind Composio accepted it as. A key kept before kinds were told apart is a project key.
    async function key(): Promise<{ value: string; kind: ManagedAppsKeyKind } | null> {
        const row = (await db.execute('SELECT sealed,revision FROM desktop_managed_app_key WHERE id=1')).rows[0]
        if (!row) return null
        const opened = Buffer.from(await crypto.open(sealContext(workspaceId, String(row.revision)), String(row.sealed))).toString('utf8')
        try {
            const parsed = JSON.parse(opened) as { key?: unknown; kind?: unknown }
            if (typeof parsed.key === 'string' && (parsed.kind === 'project' || parsed.kind === 'account')) return { value: parsed.key, kind: parsed.kind }
        } catch { /* a bare key */ }
        return { value: opened, kind: 'project' }
    }
    async function client() {
        const kept = await key()
        if (!kept) throw new ManagedAppsError(409, 'Add your Composio key first.')
        return managedAppsClient(kept.value, options.network, COMPOSIO_API, kept.kind)
    }
    async function accounts(): Promise<Account[]> {
        return (await db.execute('SELECT id,slug,toolkit,name,user_id,connected_account_id,status FROM desktop_managed_app_accounts ORDER BY name')).rows.map(row => ({
            id: String(row.id), slug: String(row.slug), toolkit: String(row.toolkit), name: String(row.name), userId: String(row.user_id),
            connectedAccountId: String(row.connected_account_id), status: row.status === 'active' ? 'active' : 'pending',
        }))
    }
    async function account(id: string): Promise<Account> {
        const found = (await accounts()).find(row => row.id === id)
        if (!found) throw new ManagedAppsError(409, 'This account is no longer in the Vault.')
        return found
    }
    /**
     * The apps on offer. With a key it is everything the person's Composio project lists; without
     * one, or while Composio cannot be reached, it is the apps the bundled catalog names.
     */
    async function offered(): Promise<OfferedApp[]> {
        const bundled: OfferedApp[] = managedAppCatalog.map(app => ({ slug: app.toolkit.toLowerCase(), name: app.name, summary: app.summary, logo: managedAppLogo(app.toolkit), noAuth: false }))
        const row = (await db.execute('SELECT revision FROM desktop_managed_app_key WHERE id=1')).rows[0]
        if (!row) return options.connect && await options.connect() ? connectApps : bundled
        const cached = appCache.get(String(row.revision))
        if (cached && Date.now() - cached.at < 6 * 60 * 60_000) return cached.apps
        const listed = await (await client()).toolkits(AbortSignal.timeout(20_000)).catch(() => null)
        if (!listed?.length) return cached?.apps ?? bundled
        const apps: OfferedApp[] = listed.map(app => ({ slug: app.slug, name: app.name, summary: app.summary, logo: managedAppLogo(app.slug, app.logo), noAuth: app.noAuth }))
        appCache.clear()
        appCache.set(String(row.revision), { at: Date.now(), apps })
        return apps
    }
    async function view(): Promise<DesktopManagedAppsView> {
        const connector = await connectMode() ? COMPOSIO_CONNECT_NAME : undefined
        const [configured, rows, attached] = await Promise.all([
            hasKey().then(kept => kept || !!connector),
            accounts(),
            db.execute('SELECT account_id,agent_id FROM desktop_managed_app_attachments ORDER BY agent_id'),
        ])
        return {
            configured, ...(connector ? { connector } : {}),
            apps: (await offered()).map(app => ({ slug: app.slug, name: app.name, summary: app.summary, ...(app.logo ? { logo: app.logo } : {}) })),
            accounts: rows.map(row => ({ id: row.id, slug: row.slug, name: row.name, status: row.status, agentIds: attached.rows.filter(link => link.account_id === row.id).map(link => String(link.agent_id)) })),
        }
    }
    async function act(action: DesktopManagedAppsAction, signal?: AbortSignal): Promise<DesktopManagedAppsResult> {
        const connect = action.action === 'set-key' ? null : await connectMode()
        // With Connect the key lives in the Vault entry, and every coworker given that entry reaches every signed-in app.
        if (connect && (action.action === 'remove-key' || action.action === 'attach')) throw new ManagedAppsError(409, 'Composio is kept in the Vault as “composio”. Change its key and its coworkers there.')
        if (action.action === 'set-key') {
            // The key is tried before it is kept, so a mistyped key is heard now and not at a coworker's first call.
            const kind = await managedAppsKeyKind(action.key, options.network, signal)
            const revision = randomUUID()
            const sealed = await crypto.seal(sealContext(workspaceId, revision), Buffer.from(JSON.stringify({ key: action.key, kind }), 'utf8'))
            await db.execute({ sql: 'INSERT INTO desktop_managed_app_key(id,sealed,revision,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET sealed=excluded.sealed, revision=excluded.revision, updated_at=excluded.updated_at', args: [sealed, revision, new Date().toISOString()] })
            toolCache.clear(); appCache.clear()
            return { view: await view() }
        }
        if (action.action === 'remove-key') {
            // The accounts belong to that key's project: without it they cannot be used or cleaned up, so they go with it.
            const composio = await client().catch(() => null)
            for (const row of await accounts()) if (row.connectedAccountId) await composio?.remove(row.connectedAccountId, signal).catch(() => {})
            await db.batch(['DELETE FROM desktop_managed_app_attachments', 'DELETE FROM desktop_managed_app_accounts', 'DELETE FROM desktop_managed_app_key'], 'write')
            toolCache.clear()
            return { view: await view() }
        }
        if (action.action === 'find') {
            if (!connect) throw new ManagedAppsError(409, 'This needs a Composio Connect key in the Vault.')
            // Composio is asked about the most used apps; one further down the list is found by pressing Connect on it.
            const known = new Map((await accounts()).map(row => [row.slug, row]))
            const apps = (await offered()).slice(0, MANAGED_APP_FIND_LIMIT)
            const live = new Set(await connect.signedIn(apps.map(app => app.slug), signal))
            const created = new Date().toISOString()
            for (const app of apps) {
                if (!live.has(app.slug)) continue
                const row = known.get(app.slug)
                if (row) await db.execute({ sql: "UPDATE desktop_managed_app_accounts SET status='active' WHERE id=?", args: [row.id] })
                else await db.execute({ sql: 'INSERT INTO desktop_managed_app_accounts(id,slug,toolkit,name,user_id,connected_account_id,status,created_at) VALUES(?,?,?,?,?,?,?,?)', args: [randomUUID(), app.slug, app.slug, app.name, '', '', 'active', created] })
            }
            return { view: await view() }
        }
        if (action.action === 'connect') {
            const app = (await offered()).find(row => row.slug === action.slug)
            if (!app) throw new ManagedAppsError(400, 'This app is not in the catalog.')
            if ((await accounts()).some(row => row.slug === app.slug)) throw new ManagedAppsError(409, 'This app already has an account in the Vault.')
            if (connect) {
                const started = await connect.connect(app.slug, signal)
                if (started.state === 'pending' && !started.signIn) throw new ManagedAppsError(502, 'Composio did not return a sign-in page.')
                await db.execute({ sql: 'INSERT INTO desktop_managed_app_accounts(id,slug,toolkit,name,user_id,connected_account_id,status,created_at) VALUES(?,?,?,?,?,?,?,?)', args: [randomUUID(), app.slug, app.slug, app.name, '', '', started.state, new Date().toISOString()] })
                return { view: await view(), ...(started.signIn ? { signIn: started.signIn } : {}) }
            }
            const composio = await client()
            const id = randomUUID(), userId = `rerun_mac_${id}`, created = new Date().toISOString()
            const insert = "INSERT INTO desktop_managed_app_accounts(id,slug,toolkit,name,user_id,connected_account_id,status,created_at) VALUES(?,?,?,?,?,?,?,?)"
            // An app that needs no sign-in is ready at once: there is nothing to link.
            if (app.noAuth) {
                await db.execute({ sql: insert, args: [id, app.slug, app.slug, app.name, userId, '', 'active', created] })
                return { view: await view() }
            }
            const link = await composio.link(userId, await composio.authConfig(app.slug, signal), options.returnUrl, signal)
            await db.execute({ sql: insert, args: [id, app.slug, app.slug, app.name, userId, link.connectedAccountId, 'pending', created] })
            return { view: await view(), signIn: link.redirectUrl }
        }
        if (action.action === 'refresh') {
            const row = await account(action.id)
            if (connect) {
                // A sign-in page lasts minutes: one still waiting is started again, so the button always leads somewhere.
                let current = await connect.status(row.toolkit, signal)
                if (current.state === 'pending' && action.retry) current = await connect.connect(row.toolkit, signal)
                if (current.state === 'active') await db.execute({ sql: "UPDATE desktop_managed_app_accounts SET status='active' WHERE id=?", args: [row.id] })
                return { view: await view(), ...(current.state === 'pending' && action.retry && current.signIn ? { signIn: current.signIn } : {}) }
            }
            if (!row.connectedAccountId) return { view: await view() }
            const remote = await (await client()).account(row.connectedAccountId, signal)
            // Only Composio's own word that this very account, for this very app, is signed in makes it usable.
            if (remote.status === 'ACTIVE' && remote.userId === row.userId && (!remote.toolkit || remote.toolkit.toLowerCase() === row.toolkit.toLowerCase())) {
                await db.execute({ sql: "UPDATE desktop_managed_app_accounts SET status='active' WHERE id=?", args: [row.id] })
            }
            return { view: await view() }
        }
        if (action.action === 'remove') {
            const row = await account(action.id)
            // With Connect the app is signed out at Composio first; if that fails the row stays, so nothing is left signed in unseen.
            if (connect) await connect.remove(row.toolkit, signal)
            if (row.connectedAccountId && !connect) await (await client()).remove(row.connectedAccountId, signal).catch(error => { if (!(error instanceof ManagedAppsError) || error.status !== 502) throw error })
            await db.batch([{ sql: 'DELETE FROM desktop_managed_app_attachments WHERE account_id=?', args: [row.id] }, { sql: 'DELETE FROM desktop_managed_app_accounts WHERE id=?', args: [row.id] }], 'write')
            return { view: await view() }
        }
        const row = await account(action.id)
        if (action.attached) {
            if (row.status !== 'active') throw new ManagedAppsError(409, 'Finish signing in to this app first.')
            if (!await options.coworkerExists(action.agentId)) throw new ManagedAppsError(409, 'This coworker is no longer available.')
            await db.execute({ sql: 'INSERT OR IGNORE INTO desktop_managed_app_attachments(account_id,agent_id) VALUES(?,?)', args: [row.id, action.agentId] })
        } else await db.execute({ sql: 'DELETE FROM desktop_managed_app_attachments WHERE account_id=? AND agent_id=?', args: [row.id, action.agentId] })
        return { view: await view() }
    }
    /** The tools a coworker holds from its managed apps. A coworker with none costs no call to Composio. */
    async function tools(agentId: string, signal: AbortSignal): Promise<ToolDefinition[]> {
        const held = (await db.execute({
            sql: "SELECT a.id FROM desktop_managed_app_accounts a JOIN desktop_managed_app_attachments t ON t.account_id=a.id WHERE t.agent_id=? AND a.status='active' ORDER BY a.name", args: [agentId],
        })).rows.map(row => String(row.id))
        if (!held.length) return []
        const composio = await client().catch(() => null)
        if (!composio) return []
        const definitions: ToolDefinition[] = []
        for (const id of held) {
            const row = await account(id)
            // An app the bundled catalog knows keeps its chosen tools; any other app gives the ones Composio features.
            const chosen = managedAppCatalog.find(entry => entry.toolkit.toLowerCase() === row.toolkit.toLowerCase())?.allowedTools ?? []
            let cached = toolCache.get(row.toolkit)
            if (!cached || Date.now() - cached.at > 10 * 60_000) {
                // An app that cannot be listed now must not hide the coworker's other tools.
                const listed = await (async () => {
                    if (chosen.length) return (await composio.tools(row.toolkit, signal)).filter(tool => chosen.includes(tool.slug))
                    const featured = await composio.tools(row.toolkit, signal, true)
                    return (featured.length ? featured : await composio.tools(row.toolkit, signal)).slice(0, MANAGED_APP_TOOL_LIMIT)
                })().catch(() => null)
                signal.throwIfAborted()
                if (listed) { cached = { at: Date.now(), tools: listed }; toolCache.set(row.toolkit, cached) }
            }
            for (const tool of cached?.tools ?? []) {
                definitions.push({
                    name: tool.slug, description: tool.description, inputSchema: tool.inputSchema, destructive: tool.destructive,
                    async execute(args, stop) {
                        // The account and its attachment are read again at the call: a removed or detached account stops here.
                        const current = (await db.execute({
                            sql: "SELECT a.user_id FROM desktop_managed_app_accounts a JOIN desktop_managed_app_attachments t ON t.account_id=a.id WHERE a.id=? AND t.agent_id=? AND a.status='active'", args: [id, agentId],
                        })).rows[0]
                        if (!current) throw new Error('This app is no longer attached to this coworker.')
                        const outcome = await (await client()).execute(tool.slug, String(current.user_id), args, stop)
                        const text = JSON.stringify(outcome.successful ? outcome.data : { error: outcome.error ?? 'The app refused this call.' }).slice(0, 900_000)
                        return { source: 'remote_mcp', untrusted: true, result: { content: [{ type: 'text', text }], ...(outcome.successful ? {} : { isError: true }) } }
                    },
                })
            }
        }
        return definitions
    }
    return { view, act, tools }
}
