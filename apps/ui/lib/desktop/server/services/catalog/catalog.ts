import 'server-only'

import { defaultMethod, requiredSecretInputs, serviceManifestSchema, type AuthMethod, type InputDef, type ServiceManifest } from '@/lib/services/manifest'
import {
    SERVICE_CATEGORIES,
    serviceRegistryKey,
    type DesktopServiceCatalogEntry,
    type DesktopServiceCatalogPage,
    type DesktopServiceDetails,
    type DesktopServiceMethodAvailability,
    type ServiceCategory,
} from '../../../../../../../packages/contracts/src/desktop-services.ts'
import { classifyDesktopServiceMethod } from './availability'

const ORIGINAL_PIN = 'a6d63a4b542674ddd002e51b39ba0df6e0807bcc'
const SEED_GIT_BLOB = 'cc7201f8b16994132ee7698eb79c088891ada2b4'
const SEED_SHA256 = 'ebe7357ea24aa2788b93ce31d34f77a5dd067b349f4b9335d147579133257e33'
const CATALOG_BASE = '447fb9f03cd1113d50d199a1ec4c433198dc0ef9'
const EXPECTED_COUNT = 216
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

// Runtime list input is wider than the strict contract schema so an unknown category fails closed.
export type DesktopServiceCatalogListInput = {
    query?: string
    category?: string
    offset?: number
    limit?: number
}

export type DesktopServiceCatalogProvenance = {
    source: 'supabase/seed.sql'
    originalPin: typeof ORIGINAL_PIN
    seedGitBlob: typeof SEED_GIT_BLOB
    seedSha256: string
    catalogBase: typeof CATALOG_BASE
    count: typeof EXPECTED_COUNT
    extractor: string
}

type SeedService = {
    slug: string
    name: string
    category: string
    summary: string
    icon: string | null
    manifest: unknown
    enabled: boolean
    verified: boolean
}

export type DesktopServiceCatalogFile = {
    provenance: DesktopServiceCatalogProvenance
    services: SeedService[]
}

type LoadedService = {
    slug: string
    name: string
    category: string
    summary: string
    icon: string | null
    enabled: boolean
    verified: boolean
    manifest: ServiceManifest
}

export type DesktopServiceManifestRecord = {
    slug: string
    name: string
    category: string
    summary: string
    icon: string | null
    enabled: true
    verified: boolean
    manifest: ServiceManifest
    details: DesktopServiceDetails
}

export type DesktopServiceCatalogApi = {
    provenance: DesktopServiceCatalogProvenance
    listDesktopServiceCatalog: (query?: DesktopServiceCatalogListInput) => DesktopServiceCatalogPage
    getDesktopServiceManifest: (slug: string) => DesktopServiceManifestRecord
    getDesktopServiceMethodAvailability: (slug: string, authMethodId: string) => DesktopServiceMethodAvailability
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    return Object.freeze(value)
}

function copyInput(input: InputDef): InputDef {
    return { ...input, ...(input.options ? { options: input.options.map(option => ({ ...option })) } : {}) }
}

function authMethodSummaries(manifest: ServiceManifest): DesktopServiceDetails['authMethods'] {
    // Same client fields as apps/ui/app/api/_services/services.service.ts toAuthMethodSummaries.
    // That module also opens Supabase and the engine, so the projection is copied here.
    return manifest.authMethods.map(method => ({
        id: method.id,
        label: method.label,
        kind: method.kind,
        recommended: method.recommended,
        inputs: method.inputs.map(copyInput),
        requiresSecrets: requiredSecretInputs(method).length > 0,
    }))
}

function availabilityFor(manifest: ServiceManifest): DesktopServiceMethodAvailability[] {
    return manifest.authMethods.map(method => classifyDesktopServiceMethod(manifest, method))
}

// Search rows use the seed columns, matching hosted literal search in services.service.ts.
// Detail name, summary, and description use the normalized manifest, matching getServiceDetails.
function toCatalogEntry(row: LoadedService): DesktopServiceCatalogEntry {
    const paidApp = row.manifest.authMethods.some(method => method.kind === 'app')
    return {
        slug: row.slug,
        name: row.name,
        category: row.category,
        summary: row.summary,
        icon: row.icon,
        requiresSecrets: requiredSecretInputs(defaultMethod(row.manifest)).length > 0,
        installed: false,
        installStatus: null,
        verified: row.verified,
        multiInstance: row.manifest.multiInstance,
        ...(paidApp ? { paidApp: true } : {}),
        availability: availabilityFor(row.manifest),
    }
}

function toDetails(row: LoadedService): DesktopServiceDetails {
    const paidApp = row.manifest.authMethods.some(method => method.kind === 'app')
    return {
        key: serviceRegistryKey(row.manifest.slug),
        slug: row.manifest.slug,
        name: row.manifest.name,
        category: row.manifest.category,
        summary: row.manifest.summary,
        description: row.manifest.description,
        icon: row.icon,
        verified: row.verified,
        authMethods: authMethodSummaries(row.manifest),
        availability: availabilityFor(row.manifest),
        installed: false,
        installStatus: null,
        multiInstance: row.manifest.multiInstance,
        instances: [],
        ...(paidApp ? { paidApp: true } : {}),
    }
}

function rank(row: LoadedService, query: string): number {
    const name = row.name.toLowerCase()
    if (name === query) return 0
    if (name.startsWith(query)) return 1
    if (name.includes(query)) return 2
    if (row.slug.toLowerCase().includes(query)) return 3
    return 4
}

function byName(left: LoadedService, right: LoadedService): number {
    return left.name.localeCompare(right.name, 'en') || left.slug.localeCompare(right.slug, 'en')
}

function assertPage(query: DesktopServiceCatalogListInput): { offset: number; limit: number; category?: ServiceCategory; text: string } {
    const offset = query.offset ?? 0
    const limit = query.limit ?? DEFAULT_LIMIT
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid catalog offset')
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error('Invalid catalog limit')
    if (query.query !== undefined && typeof query.query !== 'string') throw new Error('Invalid catalog query')
    if (query.category !== undefined && !(SERVICE_CATEGORIES as readonly string[]).includes(query.category)) {
        throw new Error(`Unknown service category: ${String(query.category)}`)
    }
    return { offset, limit, category: query.category as ServiceCategory | undefined, text: (query.query ?? '').trim().toLowerCase() }
}

function loadServices(file: DesktopServiceCatalogFile): { provenance: DesktopServiceCatalogProvenance; rows: LoadedService[]; bySlug: Map<string, LoadedService> } {
    const { provenance } = file
    if (provenance.source !== 'supabase/seed.sql' || provenance.originalPin !== ORIGINAL_PIN || provenance.seedGitBlob !== SEED_GIT_BLOB || provenance.seedSha256 !== SEED_SHA256 || provenance.catalogBase !== CATALOG_BASE || provenance.count !== EXPECTED_COUNT) {
        throw new Error('Bundled service catalog provenance does not match the pinned seed')
    }
    if (file.services.length !== EXPECTED_COUNT) throw new Error(`Bundled service catalog has ${file.services.length} rows, expected ${EXPECTED_COUNT}`)

    const rows = file.services.map(service => {
        let manifest: ServiceManifest
        try {
            manifest = serviceManifestSchema.parse(service.manifest)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`Bundled service ${service.slug} failed manifest normalization: ${message}`)
        }
        if (manifest.slug !== service.slug) throw new Error(`Bundled service ${service.slug} normalized to slug ${manifest.slug}`)
        return deepFreeze({
            slug: service.slug,
            name: service.name,
            category: service.category,
            summary: service.summary,
            icon: service.icon,
            enabled: service.enabled,
            verified: service.verified,
            manifest,
        })
    })
    const bySlug = new Map<string, LoadedService>()
    for (const row of rows) {
        if (bySlug.has(row.slug)) throw new Error(`Duplicate bundled service slug ${row.slug}`)
        bySlug.set(row.slug, row)
    }
    return { provenance, rows, bySlug }
}

export function createDesktopServiceCatalog(file: DesktopServiceCatalogFile): DesktopServiceCatalogApi {
    const loaded = loadServices(file)
    const visible = loaded.rows.filter(row => row.enabled)

    function requireRow(slug: string): LoadedService {
        const row = loaded.bySlug.get(slug)
        if (!row || !row.enabled) throw new Error(`Service not found: ${slug}`)
        return row
    }

    function listDesktopServiceCatalog(query: DesktopServiceCatalogListInput = {}): DesktopServiceCatalogPage {
        const page = assertPage(query)
        let rows = visible.filter(row => page.category === undefined || row.category === page.category)
        if (page.text) {
            rows = rows.filter(row => row.name.toLowerCase().includes(page.text) || row.slug.toLowerCase().includes(page.text) || row.summary.toLowerCase().includes(page.text))
            rows.sort((left, right) => rank(left, page.text) - rank(right, page.text) || byName(left, right))
        } else {
            rows.sort((left, right) => left.category.localeCompare(right.category, 'en') || byName(left, right))
        }
        return { services: rows.slice(page.offset, page.offset + page.limit).map(toCatalogEntry), total: rows.length }
    }

    function getDesktopServiceManifest(slug: string): DesktopServiceManifestRecord {
        const row = requireRow(slug)
        return {
            slug: row.slug,
            name: row.name,
            category: row.category,
            summary: row.summary,
            icon: row.icon,
            enabled: true,
            verified: row.verified,
            manifest: row.manifest,
            details: toDetails(row),
        }
    }

    function getDesktopServiceMethodAvailability(slug: string, authMethodId: string): DesktopServiceMethodAvailability {
        const row = requireRow(slug)
        const method: AuthMethod | undefined = row.manifest.authMethods.find(candidate => candidate.id === authMethodId)
        if (!method) throw new Error(`Unknown auth method "${authMethodId}" for ${slug}`)
        return classifyDesktopServiceMethod(row.manifest, method)
    }

    return {
        provenance: loaded.provenance,
        listDesktopServiceCatalog,
        getDesktopServiceManifest,
        getDesktopServiceMethodAvailability,
    }
}
