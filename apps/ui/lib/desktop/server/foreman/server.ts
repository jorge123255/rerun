import type { Client } from '@libsql/client'
import { foremanBindingSchema, foremanChatRefSchema } from '@rerun/contracts'
import { ZodError } from 'zod'
import type { ForemanAuthorities } from './authority'
import { createForemanRuntime, ForemanError, type ForemanRuntime } from './runtime'
import { createForemanSqliteStore } from './store'

export { DESKTOP_FOREMAN_SCHEMA_STATEMENTS } from './store'
export { ForemanRefusal, type ForemanAuthorities, type ForemanReceipt } from './authority'
export { ForemanError, type ForemanRuntime } from './runtime'

// Root opens the runtime once per launch on its own desktop database, after applying the schema
// step, then calls reconcile() at startup before serving Foreman routes.
export function openForemanRuntime(db: Client, authorities: Partial<ForemanAuthorities>, companyName: () => Promise<string>): ForemanRuntime {
    return createForemanRuntime({ store: createForemanSqliteStore(db), authorities, companyName })
}

const STATUS: Record<ForemanError['code'], number> = { stale_revision: 409, digest_mismatch: 409, conflict: 409, uncertain: 409, not_live: 409, invalid_plan: 422, authority_missing: 503, model_unavailable: 409, not_found: 404 }

async function respond(work: () => Promise<unknown>): Promise<Response> {
    try {
        return Response.json(await work(), { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
        if (error instanceof ForemanError) return Response.json({ error: error.toJSON() }, { status: STATUS[error.code] })
        if (error instanceof ZodError) return Response.json({ error: { code: 'invalid_plan', message: 'The request was not understood.' } }, { status: 400 })
        if (error instanceof Error && error.message.startsWith('Foreman runtime is not wired')) return Response.json({ error: { code: 'authority_missing', message: error.message } }, { status: 503 })
        return Response.json({ error: { code: 'uncertain', message: 'The Foreman did not answer. Nothing is retried on its own.' } }, { status: 500 })
    }
}

const body = async (request: Request) => (await request.json()) as unknown

// Handlers for root to mount after its desktop auth/origin checks. They never select a provider:
// the binding of a show_plan/navigation/discovery call comes from root's trusted run callback.
export function foremanHandlers(runtime: ForemanRuntime) {
    return {
        view: (request: Request) => respond(() => runtime.readView(foremanChatRefSchema.parse(Object.fromEntries(new URL(request.url).searchParams)))),
        decide: async (request: Request) => respond(async () => runtime.decide(await body(request))),
        recoverDecision: async (request: Request) =>
            respond(async () => {
                const raw = (await body(request)) as { chat?: unknown; requestId?: unknown }
                return runtime.recoverDecision(foremanChatRefSchema.parse(raw.chat), String(raw.requestId))
            }),
        buildAction: async (request: Request) => respond(async () => runtime.buildAction(await body(request))),
        // Engine callback only (root's authenticated engine-callback channel), never the renderer.
        engineShowPlan: (raw: { binding: unknown; toolCallId: string; input: unknown }) => runtime.recordShownPlan(foremanBindingSchema.parse(raw.binding), raw.toolCallId, raw.input),
        engineNavigate: (raw: { binding: unknown; intent: unknown; eventId: string }) => runtime.emitNavigation(foremanBindingSchema.parse(raw.binding), raw.intent, raw.eventId),
        engineDiscover: (raw: { binding: unknown; url: string }) => runtime.startDiscovery(foremanBindingSchema.parse(raw.binding), raw.url),
    }
}
