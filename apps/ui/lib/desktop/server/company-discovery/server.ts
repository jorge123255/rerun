import { companyChatIdSchema, companyWorkspaceIdSchema } from '@rerun/contracts'
import { CompanyDiscoveryError } from './authority'
import type { CompanyDiscoveryRuntime } from './runtime'

export { DESKTOP_COMPANY_DISCOVERY_SCHEMA_STATEMENTS } from './store'
export { CompanyDiscoveryError } from './authority'
export { createCompanyDiscoveryRuntime, type CompanyDiscoveryRuntime } from './runtime'
export { createCompanyDiscoverySqliteStore } from './store'

const STATUS: Record<CompanyDiscoveryError['code'], number> = {
    authority_unbound: 503,
    fetch_authority_unbound: 503,
    binding_unbound: 503,
    stale_workspace: 409,
    stale_run: 409,
    owner_deleted: 409,
    owner_disabled: 409,
    owner_replaced: 409,
    not_found: 404,
    conflict: 409,
    private_target: 422,
    closed: 409,
    cancelled: 409,
}

async function respond(work: () => Promise<unknown>): Promise<Response> {
    try {
        return Response.json(await work(), { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
        if (error instanceof CompanyDiscoveryError) return Response.json({ error: { code: error.code, message: error.message } }, { status: STATUS[error.code] })
        return Response.json({ error: { code: 'conflict', message: 'Company discovery did not answer. Nothing is fetched again on its own.' } }, { status: 409 })
    }
}

// Read, stop, retry and startup only. The Foreman collector is collectForForeman; a missing
// binding returns binding_unbound instead of starting an anonymous fetch.
export function companyDiscoveryHandlers(runtime: CompanyDiscoveryRuntime) {
    return {
        view: (request: Request) => respond(async () => {
            const query = new URL(request.url).searchParams
            return runtime.read({ workspaceId: companyWorkspaceIdSchema.parse(query.get('workspaceId')), chatId: companyChatIdSchema.parse(query.get('chatId')), discoveryId: query.get('discoveryId') ?? undefined })
        }),
        stop: async (request: Request) => respond(async () => {
            const body = await request.json() as { workspaceId?: string; chatId?: string; discoveryId?: string }
            await runtime.stop({ workspaceId: String(body.workspaceId), chatId: String(body.chatId), discoveryId: String(body.discoveryId) })
            return { stopped: true }
        }),
        retry: async (request: Request) => respond(async () => {
            const body = await request.json() as { workspaceId?: string; chatId?: string; discoveryId?: string; runId?: string; requestId?: string }
            return runtime.retry({ workspaceId: String(body.workspaceId), chatId: String(body.chatId), discoveryId: String(body.discoveryId), runId: String(body.runId), requestId: String(body.requestId) })
        }),
        reconcile: () => respond(async () => {
            await runtime.reconcile()
            return { reconciled: true }
        }),
    }
}
