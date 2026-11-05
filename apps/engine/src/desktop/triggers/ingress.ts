import { DESKTOP_TRIGGER_SLUG_RE, type DesktopTriggerFireInput, type DesktopTriggerMethod } from '@rerun/contracts'
import { dispatchDesktopTriggerFire } from './dispatch.js'
import { isPassiveVisit } from './passive-visit.js'
import type { DesktopTriggerAuthority, DesktopTriggerStore } from './types.js'
import { MAX_TRIGGER_BODY_BYTES, readBodyCapped } from './webhook-body.js'

const FIRE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

export type DesktopTriggerIngressParams = {
    engineAgentId: string
    slug: string
    token: string
}

/**
 * Constructs the original public webhook behaviour for the local Mac runtime.
 * Root mounts this only after the hosting decision. This factory never listens.
 */
export function createDesktopTriggerIngressHandler(deps: {
    authority: DesktopTriggerAuthority
    store: DesktopTriggerStore
    /** Optional resolver when the URL uses a public/local agent id instead of engine id. */
    resolveEngineAgentId?: (agentIdParam: string) => Promise<string | null>
}) {
    async function handle(req: Request, params: DesktopTriggerIngressParams): Promise<Response> {
        const slug = params.slug
        const token = params.token
        if (!DESKTOP_TRIGGER_SLUG_RE.test(slug) || !token) return Response.json({ error: 'Not found' }, { status: 404 })

        if (isPassiveVisit(req.headers)) {
            return new Response(null, { status: 204 })
        }

        if (!FIRE_METHODS.has(req.method)) return Response.json({ error: 'Not found' }, { status: 404 })

        const raw = await readBodyCapped(req, MAX_TRIGGER_BODY_BYTES)
        if (raw === null) return Response.json({ error: 'Payload too large' }, { status: 413 })

        const engineAgentId = deps.resolveEngineAgentId
            ? await deps.resolveEngineAgentId(params.engineAgentId)
            : params.engineAgentId
        if (!engineAgentId) return Response.json({ error: 'Not found' }, { status: 404 })

        const url = new URL(req.url)
        const attemptFingerprint = req.headers.get('x-desktop-trigger-attempt')?.trim() || undefined
        // Never forward Authorization/Cookie/token into the fire body beyond the path token.
        const fire: DesktopTriggerFireInput = {
            token,
            method: req.method as DesktopTriggerMethod,
            query: url.search.replace(/^\?/, ''),
            contentType: req.headers.get('content-type') ?? '',
            body: raw,
            bodyBytes: Buffer.byteLength(raw, 'utf8'),
            ...(attemptFingerprint ? { attemptFingerprint } : {}),
        }

        const outcome = await dispatchDesktopTriggerFire({
            authority: deps.authority,
            store: deps.store,
            engineAgentId,
            slug,
            fire,
        })

        if (outcome.status === 204) return new Response(null, { status: 204 })
        if (outcome.status === 413) return Response.json({ error: 'Payload too large' }, { status: 413 })
        if (outcome.status === 405) {
            return Response.json(
                { error: 'Method not allowed' },
                { status: 405, headers: outcome.allow.length ? { Allow: outcome.allow.join(', ') } : undefined },
            )
        }
        if (outcome.status === 409) return Response.json({ error: outcome.error }, { status: 409 })
        if (outcome.status === 503) return Response.json({ error: outcome.error }, { status: 503 })
        if (outcome.status !== 202) return Response.json({ error: 'Not found' }, { status: 404 })
        return Response.json(
            { runId: outcome.runId, sessionId: outcome.sessionId, trigger: slug, eventId: outcome.eventId, replay: outcome.replay },
            { status: 202 },
        )
    }

    return {
        handle,
        GET: handle,
        POST: handle,
        PUT: handle,
        PATCH: handle,
        DELETE: handle,
        HEAD: (): Response => new Response(null, { status: 200 }),
        OPTIONS: (): Response => new Response(null, { status: 204 }),
    }
}
