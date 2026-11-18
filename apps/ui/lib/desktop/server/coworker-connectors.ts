import 'server-only'
import type { Client } from '@libsql/client'
import { desktopBundledLogo, desktopConnectorServerSchema, desktopConnectorToolkitSchema, desktopCoworkerConnectorsSchema, type DesktopCoworkerConnectors, type DesktopConnectorApp } from '../connector-apps-schema'
import type { DesktopCoworkerVaultListing } from '../vault'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import bundledCatalog from './services/catalog/bundled-services.json'
import { openDesktopVault } from './vault/binding'
import { assignedManagedAccounts } from './managed-apps/assigned'
import { COMPOSIO_CONNECT, COMPOSIO_CONNECT_HEADER } from './managed-apps/client'

// Which app a chat tool row belongs to. Everything here is read from this Mac's own database and
// the catalog the app ships: no connector is opened, no credential is read and nothing is fetched,
// so a chat may ask once when it opens.

type Bundled = { slug?: string; name?: string; category?: string; icon?: string | null; manifest?: { authMethods?: { composio?: { toolkit?: string } }[] } }
type BundledApp = { slug: string; name: string; category: string; icon: string | null }

const bundled = new Map<string, BundledApp>()
// A Composio tool is named after its toolkit ("GMAIL_SEND_EMAIL"), which is not always the catalog
// slug ("googlecalendar" for "google-calendar"): both spellings, punctuation dropped, name one app.
const toolkits = new Map<string, BundledApp>()
const toolkitKey = (name: string) => name.toLowerCase().replace(/[-_]/g, '')
for (const service of (bundledCatalog as { services: Bundled[] }).services) {
    if (!service.slug) continue
    const app = { slug: service.slug, name: service.name ?? service.slug, category: service.category ?? 'other', icon: service.icon ?? null }
    bundled.set(app.slug, app)
    const toolkit = service.manifest?.authMethods?.find(method => method.composio?.toolkit)?.composio?.toolkit
    for (const name of [toolkit, app.slug]) if (name && !toolkits.has(toolkitKey(name))) toolkits.set(toolkitKey(name), app)
}

/** The name the Vault keeps a Composio Connect key under: its tools run other apps' tools by name. */
const COMPOSIO_SERVER = 'composio'

export type ConnectorSources = {
    vault: DesktopCoworkerVaultListing['attached']
    services: { serverName: string; slug: string; name: string; category: string; icon: string | null }[]
    servers: string[]
    managed: { toolkit: string; name: string; label: string }[]
}

const custom = (server: string): DesktopConnectorApp => ({ server, slug: `mcp:${server}`, name: server, icon: null, category: 'custom', custom: true })

export function desktopConnectorApps(agentId: string, sources: ConnectorSources): DesktopCoworkerConnectors {
    const servers = new Map<string, DesktopConnectorApp>()
    // An entry this listing cannot carry is left out: its rows keep their plain look, the others keep their logo.
    const add = (app: DesktopConnectorApp) => {
        const row = desktopConnectorServerSchema.safeParse({ ...app, icon: desktopBundledLogo(app.icon) })
        if (row.success && !servers.has(row.data.server)) servers.set(row.data.server, row.data)
    }
    for (const service of sources.services) add({ server: service.serverName, slug: service.slug, name: service.name, icon: service.icon ?? bundled.get(service.slug)?.icon ?? null, category: service.category })
    let composio = false
    for (const entry of sources.vault) {
        if (!('kind' in entry)) continue
        if (entry.kind === 'mcp' && entry.catalog) {
            const app = bundled.get(entry.catalog.slug)
            add({ server: entry.name, slug: entry.catalog.slug, name: app?.name ?? entry.catalog.name, ...(entry.catalog.label ? { label: entry.catalog.label } : {}), icon: app?.icon ?? null, category: app?.category ?? 'other' })
        } else if (entry.kind === 'mcp' && entry.name === COMPOSIO_SERVER && entry.url === COMPOSIO_CONNECT && entry.headerName === COMPOSIO_CONNECT_HEADER) {
            composio = true
            add({ server: entry.name, slug: 'composio', name: 'Composio', icon: null, category: 'other' })
        } else add(custom(entry.name))
    }
    for (const server of sources.servers) add(custom(server))

    // A managed app's tools carry no server name, only their toolkit. The coworker's own accounts come
    // first, so their name and label win; with Composio attached every bundled app may be run by name.
    const apps = new Map<string, DesktopCoworkerConnectors['toolkits'][number]>()
    for (const account of sources.managed) {
        const key = toolkitKey(account.toolkit), app = toolkits.get(key)
        const row = desktopConnectorToolkitSchema.safeParse({ key, slug: app?.slug ?? account.toolkit.toLowerCase(), name: app?.name ?? account.name, ...(account.label ? { label: account.label } : {}), icon: desktopBundledLogo(app?.icon), category: app?.category ?? 'other' })
        if (row.success && !apps.has(key)) apps.set(key, row.data)
    }
    if (composio || sources.managed.length) for (const [key, app] of toolkits) {
        const row = desktopConnectorToolkitSchema.safeParse({ key, ...app, icon: desktopBundledLogo(app.icon) })
        if (row.success && !apps.has(key)) apps.set(key, row.data)
    }
    return desktopCoworkerConnectorsSchema.parse({ agentId, servers: [...servers.values()].slice(0, 200), toolkits: [...apps.values()].slice(0, 600) })
}

// A table that this profile has not created yet simply has no rows.
async function rows(db: Client, sql: string, agentId: string) {
    try { return (await db.execute({ sql, args: [agentId] })).rows } catch { return [] }
}

export async function readConnectorSources(db: Client, agentId: string): Promise<Omit<ConnectorSources, 'vault'>> {
    const [services, remote, local, managed] = await Promise.all([
        rows(db, `SELECT s.plan FROM desktop_service_installs s WHERE s.owner=? AND s.state NOT IN ('disconnected','removing')
            AND NOT EXISTS(SELECT 1 FROM desktop_vault_catalog_adoptions a WHERE a.installation_id=s.id) ORDER BY s.installed_at DESC LIMIT 64`, agentId),
        rows(db, 'SELECT name FROM desktop_remote_mcp WHERE agent_id=? ORDER BY name LIMIT 32', agentId),
        rows(db, 'SELECT name FROM desktop_mcp_stdio WHERE owner=? ORDER BY name LIMIT 32', agentId),
        rows(db, `SELECT a.toolkit,a.name,a.label FROM desktop_managed_app_accounts a JOIN desktop_managed_app_attachments t ON t.account_id=a.id
            WHERE t.agent_id=? ORDER BY a.name,a.label LIMIT 200`, agentId),
    ])
    return {
        services: services.flatMap(row => {
            try {
                const plan = JSON.parse(String(row.plan)) as Record<string, unknown>
                if (typeof plan.serverName !== 'string' || typeof plan.slug !== 'string') return []
                return [{ serverName: plan.serverName, slug: plan.slug, name: typeof plan.name === 'string' ? plan.name : plan.slug, category: typeof plan.category === 'string' ? plan.category : 'other', icon: typeof plan.icon === 'string' ? plan.icon : null }]
            } catch { return [] }
        }),
        servers: [...remote, ...local].map(row => String(row.name)),
        managed: managed.map(row => ({ toolkit: String(row.toolkit), name: String(row.name), label: String(row.label ?? '') })),
    }
}

/** Refuses a coworker that is not in this workspace, as the coworker's Vault listing does. */
export async function desktopCoworkerConnectors(runtime: DesktopRuntime, agentId: string): Promise<DesktopCoworkerConnectors> {
    const vault = (await (await openDesktopVault(runtime)).forCoworker(agentId)).attached
    const db = await openDesktopDatabase(runtime.dataRoot)
    const [sources, managedAccounts] = await Promise.all([readConnectorSources(db, agentId), assignedManagedAccounts(db, runtime.workspaceId, agentId)])
    return { ...desktopConnectorApps(agentId, { vault, ...sources }), managedAccounts }
}
