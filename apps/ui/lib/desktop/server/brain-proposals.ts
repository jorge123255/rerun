import 'server-only'
import { brainProposalStatusSchema, type BrainProposalStatus } from '@rerun/contracts'
import { z } from 'zod'
import { desktopBrainProposalDecisionInputSchema, desktopBrainProposalDecisionSchema, desktopBrainProposalViewSchema } from '../brain-proposals'
import { DesktopHttpError } from './auth'
import type { DesktopRuntime } from './runtime'

type Access = { signal?: AbortSignal }
async function request<T>(runtime: DesktopRuntime, suffix: string, schema: z.ZodType<T>, access?: Access, body?: unknown): Promise<T> {
    const signal = access?.signal ? AbortSignal.any([access.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
    let response: Response
    try {
        response = await fetch(`${runtime.engine.origin}/desktop/brain/proposals${suffix}`, { method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', cache: 'no-store', signal })
    } catch { throw new DesktopHttpError(502, 'Could not reach Brain storage. Retry the same decision.') }
    if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new DesktopHttpError([400, 401, 403, 404, 409, 413, 415, 503].includes(response.status) ? response.status : 502,
            response.status === 409 ? 'This proposal or page changed. Review the current version.' : 'Brain storage request failed.')
    }
    // Bound the whole response, including a list of reviewed contents.
    const reader = response.body?.getReader()
    if (!reader) throw new DesktopHttpError(502, 'Missing Brain response.')
    const chunks: Uint8Array[] = []
    let size = 0
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
        while (true) {
            signal.throwIfAborted()
            const item = await reader.read()
            signal.throwIfAborted()
            if (item.done) break
            size += item.value.byteLength
            if (size > 32_000_000) throw new DesktopHttpError(502, 'Brain response is too large.')
            chunks.push(item.value)
        }
        return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch (error) {
        if (error instanceof DesktopHttpError) throw error
        throw new DesktopHttpError(502, 'Brain response could not be confirmed. Retry the same decision.')
    } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}) }
}
export function desktopBrainProposalStatus(value: string | null): BrainProposalStatus {
    const parsed = brainProposalStatusSchema.safeParse(value ?? 'proposed')
    if (!parsed.success) throw new DesktopHttpError(400, 'That proposal list is not available.')
    return parsed.data
}
export async function listDesktopBrainProposalViews(runtime: DesktopRuntime, status: BrainProposalStatus = 'proposed', access?: Access) {
    return (await request(runtime, `?${new URLSearchParams({ status })}`, z.object({ proposals: z.array(desktopBrainProposalViewSchema) }), access)).proposals
}
export async function countOpenDesktopBrainProposals(runtime: DesktopRuntime, access?: Access) {
    return (await request(runtime, '/count', z.object({ count: z.number().int().nonnegative() }), access)).count
}
export function decideDesktopBrainProposalView(runtime: DesktopRuntime, id: string, decision: 'accept' | 'dismiss', body: unknown, access?: Access) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new DesktopHttpError(400, 'Invalid proposal identity.')
    const parsed = desktopBrainProposalDecisionInputSchema.safeParse(body)
    if (!parsed.success || (decision === 'dismiss' && parsed.data.edits)) throw new DesktopHttpError(400, 'Review the current proposal before deciding.')
    return request(runtime, `/${encodeURIComponent(id)}/${decision}`, desktopBrainProposalDecisionSchema, access, parsed.data)
}

export async function readDesktopBrainDecisionBody(request: Request): Promise<unknown> {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new DesktopHttpError(415, 'Use application/json.')
    const reader = request.body?.getReader()
    if (!reader) throw new DesktopHttpError(400, 'Missing Brain decision.')
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            signal.throwIfAborted()
            const item = await reader.read()
            signal.throwIfAborted()
            if (item.done) break
            size += item.value.byteLength
            if (size > 300_000) throw new DesktopHttpError(413, 'Brain decision is too large.')
            chunks.push(item.value)
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { throw new DesktopHttpError(400, 'Invalid Brain decision.') }
    } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}) }
}
