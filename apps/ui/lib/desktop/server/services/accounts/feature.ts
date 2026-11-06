import 'server-only'

import { SERVICE_CATEGORIES } from '@rerun/contracts'
import type { AuthMethod, ServiceManifest } from '@/lib/services/manifest'
import {
    desktopServiceAccountMessage,
    desktopServiceAccountMutationSchema,
    DESKTOP_SERVICE_ACCOUNT_MESSAGES as M,
    type DesktopServiceAccountBinding,
    type DesktopServiceAccountView,
} from '@rerun/contracts'
import { accountMethodAvailability, additionalAccountVisible } from './availability'
import type { AccountCatalogPort } from './lifecycle'
import { accountLifecycle, type AccountLifecycleDeps } from './lifecycle'

export type AccountCatalogRow = {
    slug: string
    name: string
    category: string
    summary: string
    icon: string | null
    verified: boolean
    manifest: ServiceManifest
}

export type AccountFeatureDeps = AccountLifecycleDeps & {
    catalog: AccountCatalogPort & { page(query: { text?: string; category?: string; offset: number; limit: number }): Promise<{ total: number; services: AccountCatalogRow[] }> }
    agent(coworkerId: string): Promise<{ id: string; engineAgentId: string } | null>
}

const GENERIC = 'Local service request refused or its acknowledgement is unknown. Refresh connection state; do not assume installation or removal succeeded.'

function summarize(method: AuthMethod) {
    const server = method.mcpServers[0]
    const anonymous = ['none', 'key'].includes(method.kind) && method.inputs.length === 0 && method.mcpServers.length === 1 && !!server && Object.keys(server.headers).length === 0 && server.oauth === undefined
    return { id: method.id, label: anonymous ? 'No sign-in required' : method.label, kind: method.kind, recommended: method.recommended, inputs: method.inputs, requiresSecrets: method.inputs.some(input => input.secret) }
}

function refused(error: unknown): Response {
    const message = desktopServiceAccountMessage(error)
    return Response.json({ error: message ?? GENERIC }, { status: message ? 400 : 400, headers: { 'cache-control': 'no-store' } })
}

export function accountFeature(deps: AccountFeatureDeps) {
    const lifecycle = accountLifecycle(deps)
    const bindingFor = async (coworkerId: string, signal: AbortSignal): Promise<DesktopServiceAccountBinding> => {
        const agent = await deps.agent(coworkerId)
        if (!agent || agent.id !== coworkerId) throw new Error(M.unknownService)
        const authority = await deps.authority.current(coworkerId, 'manage', signal)
        if (authority.engineAgentId !== agent.engineAgentId) throw new Error(M.owner)
        return { coworkerId: agent.id, engineOwnerId: authority.engineAgentId }
    }
    const libraryRow = (row: AccountCatalogRow, accounts: DesktopServiceAccountView[]) => {
        const availability = row.manifest.authMethods.map(method => accountMethodAvailability(row.manifest, method.id))
        const base = accounts.find(account => account.slug === row.slug && !account.instanceId)
        const installStatus = base?.status ?? null
        return {
            slug: row.slug,
            name: row.name,
            category: row.category,
            summary: row.summary,
            icon: row.icon,
            verified: row.verified,
            requiresSecrets: row.manifest.authMethods.some(method => method.inputs.some(input => input.secret)),
            setup: 'needs_config' as const,
            setupReason: 'Choose a supported local method.',
            installed: installStatus === 'active',
            installStatus,
            multiInstance: row.manifest.multiInstance === true,
            addAccount: additionalAccountVisible({ multiInstance: row.manifest.multiInstance === true, installStatus, availability }),
            authMethods: row.manifest.authMethods.map(method => ({ ...summarize(method), availability: availability.find(item => item.id === method.id) ?? { id: method.id, supported: false, reason: M.method } })),
            methodAvailability: availability,
        }
    }
    return {
        lifecycle,
        async list(coworkerId: string, signal: AbortSignal) {
            const binding = await bindingFor(coworkerId, signal)
            return lifecycle.list(binding, signal)
        },
        async detail(coworkerId: string, slug: string, signal: AbortSignal) {
            const binding = await bindingFor(coworkerId, signal)
            const manifest = await deps.catalog.manifest(slug)
            if (!manifest || manifest.slug !== slug) throw new Error(M.unknownService)
            const accounts = (await lifecycle.list(binding, signal)).filter(account => account.slug === slug)
            const availability = manifest.authMethods.map(method => accountMethodAvailability(manifest, method.id))
            return {
                slug: manifest.slug,
                name: manifest.name,
                category: manifest.category,
                summary: manifest.summary,
                description: manifest.description,
                icon: manifest.icon ?? null,
                multiInstance: manifest.multiInstance === true,
                authMethods: manifest.authMethods.map(method => ({ ...summarize(method), availability: availability.find(item => item.id === method.id) ?? { id: method.id, supported: false, reason: M.method } })),
                methodAvailability: availability,
                accounts,
                localLimitations: 'Local HTTP accounts support anonymous, header credentials, and public OAuth sign-in. SSE supports anonymous or Bearer credentials. Hosted methods and local catalog programs are unavailable. Saving configuration does not enable Apps.',
            }
        },
        async catalog(coworkerId: string, query: { text?: string; category?: string; offset: number; limit: number }, signal: AbortSignal) {
            const binding = await bindingFor(coworkerId, signal)
            const [page, accounts] = await Promise.all([deps.catalog.page(query), lifecycle.list(binding, signal)])
            return { total: page.total, services: page.services.map(row => libraryRow(row, accounts)) }
        },
        async mutate(coworkerId: string, body: unknown, signal: AbortSignal) {
            const binding = await bindingFor(coworkerId, signal)
            const input = desktopServiceAccountMutationSchema.parse(body)
            return lifecycle.mutate(binding, input, signal)
        },
        async handle(request: Request, coworkerId: string): Promise<Response> {
            const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)])
            try {
                if (request.method === 'GET') {
                    const params = new URL(request.url).searchParams
                    const view = params.get('view') ?? 'installed'
                    if (view === 'installed') return Response.json(await this.list(coworkerId, signal), { headers: { 'cache-control': 'no-store' } })
                    if (view === 'detail') {
                        const slug = params.get('slug') ?? ''
                        if (!slug || slug.length > 200) throw new Error(M.unknownService)
                        return Response.json(await this.detail(coworkerId, slug, signal), { headers: { 'cache-control': 'no-store' } })
                    }
                    if (view === 'catalog') {
                        const category = params.get('category') ?? undefined
                        if (category && !(SERVICE_CATEGORIES as readonly string[]).includes(category)) throw new Error(M.unknownService)
                        const offset = Number(params.get('offset') ?? '0')
                        const limit = Number(params.get('limit') ?? '50')
                        if (!Number.isInteger(offset) || !Number.isInteger(limit) || offset < 0 || limit < 1 || limit > 100) throw new Error(M.unknownService)
                        return Response.json(await this.catalog(coworkerId, { text: params.get('query') ?? undefined, category, offset, limit }, signal), { headers: { 'cache-control': 'no-store' } })
                    }
                    throw new Error(M.unknownService)
                }
                if (request.method !== 'POST') throw new Error(M.unsupported)
                const raw = await request.text()
                if (raw.length > 32768) throw new Error(M.unsupported)
                let body: unknown
                try {
                    body = JSON.parse(raw)
                } catch {
                    throw new Error(M.unsupported)
                }
                if (body && typeof body === 'object' && ('engineOwnerId' in body || 'engineId' in body || 'url' in body || 'headers' in body)) throw new Error(M.unsupported)
                return Response.json(await this.mutate(coworkerId, body, signal), { headers: { 'cache-control': 'no-store' } })
            } catch (error) {
                if (error instanceof Error && error.message === M.unknownService && request.method === 'GET') return Response.json({ error: M.unknownService }, { status: 404, headers: { 'cache-control': 'no-store' } })
                return refused(error)
            }
        },
    }
}

export type AccountFeature = ReturnType<typeof accountFeature>
