import type { CompanyBriefModelRef, DesktopCompanyProfileEngineOutcome } from '@rerun/contracts'
import type { CompanyProfileInferenceAdapter } from './model.ts'

export type BoundedModelResult =
    | { ok: true; text: string }
    | { ok: false; outcome: Exclude<DesktopCompanyProfileEngineOutcome, { status: 'succeeded' }> }

export async function completeBoundedCompanyProfileModel(
    input: { model: CompanyBriefModelRef; prompt: string; deadlineMs: number; signal?: AbortSignal },
    adapter: CompanyProfileInferenceAdapter,
): Promise<BoundedModelResult> {
    const timeout = AbortSignal.timeout(input.deadlineMs)
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
    try {
        if (input.signal?.aborted) return { ok: false, outcome: { status: 'cancelled' } }
        if (!await adapter.confirm(input.model)) return { ok: false, outcome: { status: 'unavailable', reason: 'missing_configuration' } }
        if (input.signal?.aborted) return { ok: false, outcome: { status: 'cancelled' } }
        if (timeout.aborted) return { ok: false, outcome: { status: 'unavailable', reason: 'timeout' } }
        const text = await adapter.complete({ selection: input.model, prompt: input.prompt, signal })
        if (input.signal?.aborted) return { ok: false, outcome: { status: 'cancelled' } }
        if (timeout.aborted) return { ok: false, outcome: { status: 'unavailable', reason: 'timeout' } }
        if (text === null) return { ok: false, outcome: { status: 'unavailable', reason: 'model_unavailable' } }
        return { ok: true, text }
    } catch {
        if (input.signal?.aborted) return { ok: false, outcome: { status: 'cancelled' } }
        if (timeout.aborted) return { ok: false, outcome: { status: 'unavailable', reason: 'timeout' } }
        return { ok: false, outcome: { status: 'error', reason: 'model_failed' } }
    }
}

export function parseCompanyProfileJson(text: string): unknown {
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
    try { return JSON.parse(trimmed) } catch { return null }
}
