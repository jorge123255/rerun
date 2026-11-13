import 'server-only'
import { getDesktopServiceManifest, listDesktopServiceCatalog } from '../services/catalog'
import { compileAccountService, CATALOG_CUSTOM_HEADER_REASON } from '../services/accounts/compiler'
import { oauthHttps } from '../mcp/oauth-network'
import { desktopVaultMutation } from '../../vault'

function compileConnection(manifest: ReturnType<typeof getDesktopServiceManifest>['manifest'], methodId: string, values: Record<string, string>) {
    const { plan, headers, bearer } = compileAccountService(manifest, methodId, values, { id: methodId, supported: true }, { label: manifest.name })
    const names = Object.keys(headers)
    if (names.length > 1) throw new Error('This app needs more than one authentication header')
    const header = !bearer && names.length ? { name: names[0], value: headers[names[0]] } : undefined
    const connection = desktopVaultMutation.parse({
        operation: 'create-server', name: plan.serverName, url: oauthHttps(plan.url).href, bearer, header,
    })
    if (connection.operation !== 'create-server') throw new Error('Invalid catalog connection')
    return { ...connection, displayName: manifest.name }
}

function availableMethods({ manifest, details }: ReturnType<typeof getDesktopServiceManifest>) {
    return details.authMethods.flatMap(method => {
        const availability = details.availability.find(item => item.id === method.id)
        if (!(method.kind === 'key' || method.kind === 'none')
            || (!availability?.supported && availability?.reason !== CATALOG_CUSTOM_HEADER_REASON)
            || manifest.authMethods.find(item => item.id === method.id)?.mcpServers[0]?.transport !== 'http') return []

        // Compile the same shape as a save, without using any saved credentials.
        const values = Object.fromEntries(method.inputs.filter(input => input.required)
            .map(input => [input.key, 'catalog-eligibility-fixture']))
        try {
            compileConnection(manifest, method.id, values)
            return [{ ...method, availability: { id: method.id, supported: true } }]
        } catch { return [] }
    })
}

export function vaultCatalog(query: string) {
    return listDesktopServiceCatalog({ query, limit: 500 }).services.flatMap(row => {
        const methods = availableMethods(getDesktopServiceManifest(row.slug))
        return methods.length ? [{ slug: row.slug, name: row.name, summary: row.summary, methods }] : []
    })
}

export function compileVaultCatalogApp(slug: string, methodId: string, values: Record<string, string>) {
    const catalog = getDesktopServiceManifest(slug)
    if (!availableMethods(catalog).some(item => item.id === methodId)) throw new Error('Unsupported catalog method')
    return compileConnection(catalog.manifest, methodId, values)
}
