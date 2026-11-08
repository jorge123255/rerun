import {
    DESKTOP_CUSTOM_PROVIDER_VERSION,
    customProviderDraftProbeSchema,
    customProviderModelSchema,
    customProviderProblemSchema,
    customProviderProbeSchema,
    customProviderReceiptSchema,
    customProviderRequestSchema,
    customProviderSnapshotSchema,
    type CustomProviderChange,
    type CustomProviderDraftProbe,
    type CustomProviderIdentity,
    type CustomProviderModel,
    type CustomProviderProbe,
    type CustomProviderReceipt,
    type CustomProviderRequest,
    type CustomProviderSnapshot,
} from '@rerun/contracts'
import { z } from 'zod'
import { DESKTOP_CUSTOM_PROVIDER_ROUTE, UNAVAILABLE_MESSAGE } from './messages'

export type DesktopCustomProviderFailure = { ok: false; reason: 'unavailable' | 'cancelled' | 'invalid' | 'refused'; message: string }
export type DesktopCustomProviderResult<T> = { ok: true; value: T } | DesktopCustomProviderFailure

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

const GENERIC = UNAVAILABLE_MESSAGE

function failure(reason: DesktopCustomProviderFailure['reason'], message = GENERIC): DesktopCustomProviderFailure {
    return { ok: false, reason, message }
}

function safeMessage(value: unknown, secret: string | undefined): string {
    const text = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : GENERIC
    if (secret && secret.length > 0 && text.includes(secret)) return GENERIC
    return text.slice(0, 300) || GENERIC
}

async function readJson(response: Response, signal: AbortSignal, secret: string | undefined): Promise<{ ok: true; value: unknown } | DesktopCustomProviderFailure> {
    const reader = response.body?.getReader()
    if (!reader) return failure('unavailable')
    const chunks: Uint8Array[] = []
    let count = 0
    try {
        for (;;) {
            if (signal.aborted) {
                await reader.cancel().catch(() => {})
                return failure('cancelled')
            }
            const next = await reader.read()
            if (next.done) break
            count += next.value.byteLength
            if (count > 1_000_000) {
                await reader.cancel().catch(() => {})
                return failure('unavailable')
            }
            chunks.push(next.value)
        }
    } catch (error) {
        await reader.cancel().catch(() => {})
        return failure(error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'unavailable')
    } finally {
        reader.releaseLock()
    }
    const bytes = new Uint8Array(count)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
    }
    try {
        return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) }
    } catch {
        return failure('unavailable', safeMessage(undefined, secret))
    }
}

function secretOf(body: CustomProviderRequest): string | undefined {
    if (body.action === 'probe_draft') return body.apiKey
    if (body.action === 'change' && body.change.action !== 'disconnect') return body.change.apiKey
    return undefined
}

const DRAFT_KEYS = ['requestId', 'workspaceId', 'status', 'models', 'problem', 'manualModel', 'manualUsable', 'observedAt']

/** A's probeCustomDraft return has no published schema. Accept only those fields, or nothing. */
export type DesktopCustomDraftProbeResult = {
    requestId: string
    workspaceId: number
    status: CustomProviderProbe['status']
    models: CustomProviderModel[]
    problem: CustomProviderProbe['problem']
    manualModel: string | null
    manualUsable: boolean
    observedAt: number
}

function parseDraftProbe(value: unknown, sent: { requestId: string; workspaceId: number }): DesktopCustomDraftProbeResult | null {
    if (!value || typeof value !== 'object') return null
    const row = value as Record<string, unknown>
    if (Object.keys(row).some(key => !DRAFT_KEYS.includes(key))) return null
    if (row.requestId !== sent.requestId || row.workspaceId !== sent.workspaceId) return null
    const status = row.status
    const manualModel = row.manualModel
    const manualUsable = row.manualUsable
    const observedAt = row.observedAt
    if (status !== 'fresh' && status !== 'empty' && status !== 'unavailable') return null
    const models = z.array(customProviderModelSchema).max(256).safeParse(row.models)
    const problem = customProviderProblemSchema.nullable().safeParse(row.problem)
    if (!models.success || !problem.success || typeof manualUsable !== 'boolean' || typeof observedAt !== 'number') return null
    if (!(manualModel === null || (typeof manualModel === 'string' && manualModel.length > 0 && manualModel.length <= 256))) return null
    return { requestId: sent.requestId, workspaceId: sent.workspaceId, status, models: models.data, problem: problem.data, manualModel, manualUsable, observedAt }
}

export function createDesktopCustomProviderClient(options?: { fetch?: FetchLike; route?: string }) {
    const fetchImpl = options?.fetch ?? fetch
    const route = options?.route ?? DESKTOP_CUSTOM_PROVIDER_ROUTE
    async function post(body: unknown, signal: AbortSignal): Promise<DesktopCustomProviderResult<unknown>> {
        if (DESKTOP_CUSTOM_PROVIDER_VERSION !== 1) return failure('unavailable')
        const parsed = customProviderRequestSchema.safeParse(body)
        if (!parsed.success) return failure('invalid', 'Check the address and try again.')
        const change = parsed.data.action === 'change' ? parsed.data.change : null
        if (change?.action === 'update' && change.apiKey !== undefined && change.clearSecret) return failure('invalid', 'Check the address and try again.')
        try {
            const response = await fetchImpl(route, {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
                redirect: 'error',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify(parsed.data),
                signal,
            })
            const json = await readJson(response, signal, secretOf(parsed.data))
            if (!json.ok) return json
            if (response.status === 409) return failure('unavailable', safeMessage(json.value, secretOf(parsed.data)))
            if (response.status === 401 || response.status === 403) return failure('refused', safeMessage(json.value, secretOf(parsed.data)))
            if (!response.ok) return failure('unavailable', safeMessage(json.value, secretOf(parsed.data)))
            return { ok: true, value: json.value }
        } catch (error) {
            return failure(error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'unavailable')
        }
    }
    return {
        route,
        async read(identity: CustomProviderIdentity, signal: AbortSignal): Promise<DesktopCustomProviderResult<CustomProviderSnapshot>> {
            const result = await post({ action: 'read', identity }, signal)
            if (!result.ok) return result
            const snapshot = customProviderSnapshotSchema.safeParse(result.value)
            return snapshot.success ? { ok: true, value: snapshot.data } : failure('invalid')
        },
        async probe(identity: CustomProviderIdentity, manualModel: string | undefined, signal: AbortSignal): Promise<DesktopCustomProviderResult<CustomProviderProbe>> {
            const result = await post({ action: 'probe', identity, ...(manualModel ? { manualModel } : {}) }, signal)
            if (!result.ok) return result
            const probe = customProviderProbeSchema.safeParse(result.value)
            return probe.success ? { ok: true, value: probe.data } : failure('invalid')
        },
        async probeDraft(draft: CustomProviderDraftProbe, signal: AbortSignal): Promise<DesktopCustomProviderResult<DesktopCustomDraftProbeResult>> {
            const parsed = customProviderDraftProbeSchema.safeParse(draft)
            if (!parsed.success) return failure('invalid', 'Check the address and try again.')
            const result = await post(parsed.data, signal)
            if (!result.ok) return result
            const value = parseDraftProbe(result.value, parsed.data)
            return value ? { ok: true, value } : failure('invalid')
        },
        async change(change: CustomProviderChange, signal: AbortSignal): Promise<DesktopCustomProviderResult<CustomProviderReceipt>> {
            const result = await post({ action: 'change', change }, signal)
            if (!result.ok) return result
            const receipt = customProviderReceiptSchema.safeParse(result.value)
            return receipt.success ? { ok: true, value: receipt.data } : failure('invalid')
        },
    }
}

export type DesktopCustomProviderClient = ReturnType<typeof createDesktopCustomProviderClient>
