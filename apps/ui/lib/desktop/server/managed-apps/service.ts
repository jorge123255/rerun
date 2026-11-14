import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { DesktopManagedAppsAction, DesktopManagedAppsResult, DesktopManagedAppsView } from '@rerun/contracts'
import bundledCatalog from '../services/catalog/bundled-services.json'
import type { DesktopSecretCrypto } from '../secret-requests/crypto'
import { managedAppsClient, ManagedAppsError, type ManagedAppsFetch } from './client'

type CatalogApp = { slug: string; name: string; summary: string; toolkit: string; allowedTools: readonly string[] }
type BundledService = { slug?: string; name?: string; summary?: string; manifest?: { authMethods?: { kind?: string; composio?: { toolkit?: string; allowedTools?: string[] } }[] } }

/** The apps of the bundled catalog whose only sign-in is a managed one. */
export const managedAppCatalog: readonly CatalogApp[] = ((bundledCatalog as { services: BundledService[] }).services).flatMap(service => {
    const method = service.manifest?.authMethods?.find(row => row.kind === 'composio' && row.composio?.toolkit)
    if (!service.slug || !method?.composio?.toolkit) return []
    return [{ slug: service.slug, name: service.name ?? service.slug, summary: (service.summary ?? '').slice(0, 600), toolkit: method.composio.toolkit, allowedTools: method.composio.allowedTools ?? [] }]
}).sort((a, b) => a.name.localeCompare(b.name))

// What each app offers changes rarely; one listing serves every coworker for ten minutes.
const toolCache = new Map<string, { at: number; tools: Awaited<ReturnType<ReturnType<typeof managedAppsClient>['tools']>> }>()
const sealContext = (workspaceId: number, revision: string) => ({ domain: 'vault' as const, agentId: 'managed-apps', key: 'composio-key', version: 1, workspaceId, revision })
type Account = { id: string; slug: string; toolkit: string; name: string; userId: string; connectedAccountId: string; status: 'pending' | 'active' }
type ToolDefinition = {
    name: string; description: string; inputSchema: Record<string, unknown>; destructive: boolean
    execute(args: Record<string, unknown>, signal: AbortSignal, toolCallId: string): Promise<{ source: 'remote_mcp'; untrusted: true; result: Record<string, unknown> }>
}

export function desktopManagedApps(db: Client, crypto: DesktopSecretCrypto, workspaceId: number, options: { network?: ManagedAppsFetch; returnUrl: string; coworkerExists(agentId: string): Promise<boolean> }) {
    async function key(): Promise<string | null> {
        const row = (await db.execute('SELECT sealed,revision FROM desktop_managed_app_key WHERE id=1')).rows[0]
        if (!row) return null
        return Buffer.from(await crypto.open(sealContext(workspaceId, String(row.revision)), String(row.sealed))).toString('utf8')
    }
    async function client() {
        const value = await key()
        if (!value) throw new ManagedAppsError(409, 'Add your Composio key first.')
        return managedAppsClient(value, options.network)
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
    async function view(): Promise<DesktopManagedAppsView> {
        const [configured, rows, attached] = await Promise.all([
            db.execute('SELECT 1 FROM desktop_managed_app_key WHERE id=1').then(result => result.rows.length === 1),
            accounts(),
            db.execute('SELECT account_id,agent_id FROM desktop_managed_app_attachments ORDER BY agent_id'),
        ])
        return {
            configured,
            apps: managedAppCatalog.map(app => ({ slug: app.slug, name: app.name, summary: app.summary })),
            accounts: rows.map(row => ({ id: row.id, slug: row.slug, name: row.name, status: row.status, agentIds: attached.rows.filter(link => link.account_id === row.id).map(link => String(link.agent_id)) })),
        }
    }
    async function act(action: DesktopManagedAppsAction, signal?: AbortSignal): Promise<DesktopManagedAppsResult> {
        if (action.action === 'set-key') {
            // The key is tried before it is kept, so a mistyped key is heard now and not at a coworker's first call.
            await managedAppsClient(action.key, options.network).check(signal)
            const revision = randomUUID()
            const sealed = await crypto.seal(sealContext(workspaceId, revision), Buffer.from(action.key, 'utf8'))
            await db.execute({ sql: 'INSERT INTO desktop_managed_app_key(id,sealed,revision,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET sealed=excluded.sealed, revision=excluded.revision, updated_at=excluded.updated_at', args: [sealed, revision, new Date().toISOString()] })
            toolCache.clear()
            return { view: await view() }
        }
        if (action.action === 'remove-key') {
            // The accounts belong to that key's project: without it they cannot be used or cleaned up, so they go with it.
            const composio = await client().catch(() => null)
            for (const row of await accounts()) await composio?.remove(row.connectedAccountId, signal).catch(() => {})
            await db.batch(['DELETE FROM desktop_managed_app_attachments', 'DELETE FROM desktop_managed_app_accounts', 'DELETE FROM desktop_managed_app_key'], 'write')
            toolCache.clear()
            return { view: await view() }
        }
        if (action.action === 'connect') {
            const app = managedAppCatalog.find(row => row.slug === action.slug)
            if (!app) throw new ManagedAppsError(400, 'This app is not in the catalog.')
            if ((await accounts()).some(row => row.slug === app.slug)) throw new ManagedAppsError(409, 'This app already has an account in the Vault.')
            const composio = await client()
            const id = randomUUID(), userId = `rerun_mac_${id}`
            const link = await composio.link(userId, await composio.authConfig(app.toolkit, signal), options.returnUrl, signal)
            await db.execute({ sql: "INSERT INTO desktop_managed_app_accounts(id,slug,toolkit,name,user_id,connected_account_id,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)", args: [id, app.slug, app.toolkit, app.name, userId, link.connectedAccountId, new Date().toISOString()] })
            return { view: await view(), signIn: link.redirectUrl }
        }
        if (action.action === 'refresh') {
            const row = await account(action.id)
            const remote = await (await client()).account(row.connectedAccountId, signal)
            // Only Composio's own word that this very account, for this very app, is signed in makes it usable.
            if (remote.status === 'ACTIVE' && remote.userId === row.userId && (!remote.toolkit || remote.toolkit.toLowerCase() === row.toolkit.toLowerCase())) {
                await db.execute({ sql: "UPDATE desktop_managed_app_accounts SET status='active' WHERE id=?", args: [row.id] })
            }
            return { view: await view() }
        }
        if (action.action === 'remove') {
            const row = await account(action.id)
            await (await client()).remove(row.connectedAccountId, signal).catch(error => { if (!(error instanceof ManagedAppsError) || error.status !== 502) throw error })
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
            const row = await account(id), app = managedAppCatalog.find(entry => entry.slug === row.slug)
            if (!app) continue
            let cached = toolCache.get(app.toolkit)
            if (!cached || Date.now() - cached.at > 10 * 60_000) {
                // An app that cannot be listed now must not hide the coworker's other tools.
                const listed = await composio.tools(app.toolkit, signal).catch(() => null)
                signal.throwIfAborted()
                if (listed) { cached = { at: Date.now(), tools: listed }; toolCache.set(app.toolkit, cached) }
            }
            for (const tool of cached?.tools ?? []) {
                if (app.allowedTools.length && !app.allowedTools.includes(tool.slug)) continue
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
