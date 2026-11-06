import 'server-only'
import {
    companyBriefAttemptSchema,
    companyBriefHandoffResultSchema,
    type CompanyBriefAttempt,
    type CompanyBriefHandoffInput,
    type CompanyBriefHandoffResult,
    type CompanyBriefSynthesizeInput,
} from '@rerun/contracts'
import { z } from 'zod'
import { DesktopHttpError } from '../auth'
import type { DesktopRuntime } from '../runtime'

type Access = { signal?: AbortSignal }
const attemptResponse = z.object({ attempt: companyBriefAttemptSchema })
const readResponse = z.object({ attempt: companyBriefAttemptSchema.nullable() })
const synthesizeResponse = z.object({ attempt: companyBriefAttemptSchema, modelCalled: z.boolean() })

async function request<T>(runtime: DesktopRuntime, suffix: string, schema: z.ZodType<T>, access?: Access, body?: unknown): Promise<T> {
    const signal = access?.signal ? AbortSignal.any([access.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
    let response: Response
    try {
        response = await fetch(`${runtime.engine.origin}/desktop/company-brief${suffix}`, {
            method: body === undefined && suffix.startsWith('/?') ? 'GET' : body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: 'error', cache: 'no-store', signal,
        })
    } catch { throw new DesktopHttpError(502, 'Could not reach company research. Retry the same request.') }
    if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new DesktopHttpError([400, 404, 409, 413, 415, 503].includes(response.status) ? response.status : 502, 'Company research request failed.')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new DesktopHttpError(502, 'Missing company research response.')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            signal.throwIfAborted()
            const item = await reader.read()
            if (item.done) break
            size += item.value.byteLength
            if (size > 1_000_000) throw new DesktopHttpError(502, 'Company research response is too large.')
            chunks.push(item.value)
        }
        return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch (error) {
        if (error instanceof DesktopHttpError) throw error
        throw new DesktopHttpError(502, 'Company research response could not be confirmed. Retry the same request.')
    } finally { void reader.cancel().catch(() => {}) }
}

export function readCompanyBrief(runtime: DesktopRuntime, workspaceId: string, chatId: string, access?: Access): Promise<{ attempt: CompanyBriefAttempt | null }> {
    return request(runtime, `/?${new URLSearchParams({ workspaceId, chatId })}`, readResponse, access)
}

export function synthesizeCompanyBrief(runtime: DesktopRuntime, body: CompanyBriefSynthesizeInput, access?: Access) {
    return request(runtime, '/synthesize', synthesizeResponse, access, body)
}

export function observeCompanyBrief(runtime: DesktopRuntime, body: { workspaceId: string; chatId: string; sourceRevision: string; active: boolean }, access?: Access) {
    return request(runtime, '/observe', z.object({ ok: z.literal(true) }), access, body)
}

export function cancelCompanyBrief(runtime: DesktopRuntime, body: { requestId: string; workspaceId: string; chatId: string }, access?: Access) {
    return request(runtime, '/cancel', attemptResponse, access, body)
}

export function editCompanyBrief(runtime: DesktopRuntime, body: { requestId: string; workspaceId: string; chatId: string; expectedDraftRevision: number; brief: string }, access?: Access) {
    return request(runtime, '/edit', attemptResponse, access, body)
}

export function dismissCompanyBrief(runtime: DesktopRuntime, body: { requestId: string; workspaceId: string; chatId: string }, access?: Access) {
    return request(runtime, '/dismiss', attemptResponse, access, body)
}

export function retryCompanyBrief(runtime: DesktopRuntime, body: CompanyBriefSynthesizeInput & { previousRequestId: string }, access?: Access) {
    return request(runtime, '/retry', synthesizeResponse, access, body)
}

export function handoffCompanyBrief(runtime: DesktopRuntime, body: CompanyBriefHandoffInput, access?: Access): Promise<CompanyBriefHandoffResult> {
    return request(runtime, '/handoff', companyBriefHandoffResultSchema, access, body)
}


export function cancelCompanyBriefChat(runtime: DesktopRuntime, body: { workspaceId: string; chatId: string }, access?: Access) {
    return request(runtime, '/cancel-chat', z.object({ ok: z.literal(true) }), access, body)
}


export function readCompanyBriefHandoff(runtime: DesktopRuntime, body: CompanyBriefHandoffInput, access?: Access) {
    return request(runtime, '/handoff-receipt', z.object({ receipt: companyBriefHandoffResultSchema.nullable() }), access, body)
}
