import 'server-only'
import { getDesktopServiceManifest, listDesktopServiceCatalog } from '../services/catalog'
import { compileAccountService, CATALOG_CUSTOM_HEADER_REASON } from '../services/accounts/compiler'
import { compileCatalogOAuth, oauthAccountServerName } from '../services/oauth/compiler'
import { DESKTOP_METHOD_REASONS } from '../services/catalog/availability'
import { oauthHttps } from '../mcp/oauth-network'
import { vaultSignInPlan } from '../mcp/github-device'
import { desktopVaultMutation } from '../../vault'

type CatalogRecord = ReturnType<typeof getDesktopServiceManifest>
type CatalogMethod = CatalogRecord['details']['authMethods'][number] & { availability: { id: string; supported: boolean; reason?: string } }

/** The Vault offers a sign-in only where this Mac can finish it: loopback registration, or a built-in sign-in such as GitHub's. */
const builtInSignIn = (endpoint: string) => vaultSignInPlan()(endpoint).kind === 'github-device'

function compileConnection(manifest: ReturnType<typeof getDesktopServiceManifest>['manifest'], methodId: string, values: Record<string, string>, instanceId?: string) {
    if (instanceId && !manifest.multiInstance) throw new Error('This app does not support additional accounts')
    const selected = manifest.authMethods.find(method => method.id === methodId)
    if (selected?.kind === 'oauth') {
        if (Object.keys(values).length) throw new Error('Browser sign-in does not accept credentials here')
        const plan = compileCatalogOAuth(manifest, methodId, { builtInSignIn })
        return { ...parseConnection({ name: oauthAccountServerName(plan, instanceId), url: plan.endpoint, bearer: '', browserSignIn: true }, manifest.name), skills: plan.skills, transport: 'http' as const }
    }
    const { plan, headers, bearer } = compileAccountService(manifest, methodId, values, { id: methodId, supported: true }, { label: manifest.name, instanceId })
    const names = Object.keys(headers)
    if (names.length > 1) throw new Error('This app needs more than one authentication header')
    const header = !bearer && names.length ? { name: names[0], value: headers[names[0]] } : undefined
    return { ...parseConnection({ name: plan.serverName, url: oauthHttps(plan.url).href, bearer, header }, manifest.name), skills: plan.skills, transport: plan.transport ?? 'http' }
}

function parseConnection(fields: object, displayName: string) {
    const connection = desktopVaultMutation.parse({ operation: 'create-server', ...fields })
    if (connection.operation !== 'create-server') throw new Error('Invalid catalog connection')
    return { ...connection, displayName }
}

export function vaultCatalogMethods({ manifest, details }: CatalogRecord): CatalogMethod[] {
    return details.authMethods.flatMap(method => {
        const availability = details.availability.find(item => item.id === method.id)
        const transport = manifest.authMethods.find(item => item.id === method.id)?.mcpServers[0]?.transport
        const direct = (method.kind === 'key' || method.kind === 'none')
            && (transport === 'http' && (availability?.supported || availability?.reason === CATALOG_CUSTOM_HEADER_REASON)
                || transport === 'sse' && availability?.reason === DESKTOP_METHOD_REASONS.sse)
        if (!direct && method.kind !== 'oauth') return []

        // Compile the same shape as a save, without using any saved credentials.
        const values = Object.fromEntries(method.inputs.filter(input => input.required)
            .map(input => [input.key, 'catalog-eligibility-fixture']))
        try {
            compileConnection(manifest, method.id, values)
            return [{ ...method, availability: { id: method.id, supported: true } }]
        } catch { return [] }
    })
}

/** Why a catalog sign-in this Mac cannot finish is not offered, when there is a reason worth showing. */
function unavailableSignIn(record: CatalogRecord, methodId: string) {
    const url = record.manifest.authMethods.find(method => method.id === methodId && method.kind === 'oauth')?.mcpServers[0]?.url
    const plan = url ? vaultSignInPlan()(url) : null
    return plan?.kind === 'unavailable' ? plan.message : null
}

/**
 * The methods the Vault shows for an app: every offered method, then a sign-in it cannot offer here
 * shown as unavailable with its reason. When the catalog recommends a method that is not offered, the
 * first offered one is recommended instead; the recommended method comes first.
 */
export function vaultCatalogDisplayMethods(record: CatalogRecord): CatalogMethod[] {
    const offered = vaultCatalogMethods(record)
    const withheld = record.details.authMethods.flatMap(method => {
        if (offered.some(item => item.id === method.id)) return []
        const reason = unavailableSignIn(record, method.id)
        return reason ? [{ ...method, availability: { id: method.id, supported: false, reason } }] : []
    })
    const pick = record.details.authMethods.find(method => method.recommended)
    const recommended = pick && offered.some(method => method.id === pick.id) ? pick.id : pick ? offered[0]?.id : undefined
    return [...offered, ...withheld]
        .map(method => ({ ...method, recommended: method.id === recommended }))
        .sort((a, b) => Number(b.recommended) - Number(a.recommended))
}

export function vaultCatalog(query: string) {
    return listDesktopServiceCatalog({ query, limit: 500 }).services.flatMap(row => {
        const record = getDesktopServiceManifest(row.slug)
        if (!vaultCatalogMethods(record).length) return []
        return [{ slug: row.slug, name: row.name, summary: row.summary, icon: row.icon, multiInstance: row.multiInstance, methods: vaultCatalogDisplayMethods(record) }]
    })
}

export function compileVaultCatalogApp(slug: string, methodId: string, values: Record<string, string>, instanceId?: string) {
    const catalog = getDesktopServiceManifest(slug)
    if (!vaultCatalogMethods(catalog).some(item => item.id === methodId)) throw new Error('Unsupported catalog method')
    return compileConnection(catalog.manifest, methodId, values, instanceId)
}

export function vaultCatalogAllowsInstances(slug: string) {
    return getDesktopServiceManifest(slug).manifest.multiInstance
}

export function vaultCatalogSkills(slug: string, methodId: string) {
    const catalog = getDesktopServiceManifest(slug)
    const method = vaultCatalogMethods(catalog).find(item => item.id === methodId)
    if (!method) throw new Error('Unsupported catalog method')
    const fields = Object.fromEntries(method.inputs.filter(input => input.required).map(input => [input.key, 'catalog-eligibility-fixture']))
    return compileConnection(catalog.manifest, methodId, fields).skills
}
