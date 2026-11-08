import 'server-only'
import {
    desktopCompanyProfileEngineOutcomeSchema,
    type DesktopCompanyProfileEngineDecideInput,
    type DesktopCompanyProfileEngineEnrichInput,
    type DesktopCompanyProfileEngineOutcome,
} from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import type { DesktopRuntime } from '../runtime'

export type DesktopCompanyProfileEngineClient = {
    decide(input: DesktopCompanyProfileEngineDecideInput, signal: AbortSignal): Promise<DesktopCompanyProfileEngineOutcome>
    enrich(input: DesktopCompanyProfileEngineEnrichInput, signal: AbortSignal): Promise<DesktopCompanyProfileEngineOutcome>
}

export function createDesktopCompanyProfileEngineClient(runtime: DesktopRuntime): DesktopCompanyProfileEngineClient {
    return {
        decide: (input, signal) => request(runtime, '/decide', input, signal, 10_000),
        enrich: (input, signal) => request(runtime, '/enrich', input, signal, 40_000),
    }
}

async function request(
    runtime: DesktopRuntime,
    suffix: string,
    body: DesktopCompanyProfileEngineDecideInput | DesktopCompanyProfileEngineEnrichInput,
    parent: AbortSignal,
    timeoutMs: number,
): Promise<DesktopCompanyProfileEngineOutcome> {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)])
    let response: Response
    try {
        response = await fetch(`${runtime.engine.origin}/desktop/company-profile${suffix}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body), redirect: 'error', cache: 'no-store', signal,
        })
    } catch {
        throw new DesktopHttpError(502, 'Company profile inference could not be confirmed. Retry the same request.')
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new DesktopHttpError(response.status === 409 ? 409 : 502, 'Company profile inference request failed.')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new DesktopHttpError(502, 'Missing company profile response.')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            signal.throwIfAborted()
            const item = await reader.read()
            if (item.done) break
            size += item.value.byteLength
            if (size > 1_000_000) throw new DesktopHttpError(502, 'Company profile response is too large.')
            chunks.push(item.value)
        }
        return desktopCompanyProfileEngineOutcomeSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch (error) {
        if (error instanceof DesktopHttpError) throw error
        throw new DesktopHttpError(502, 'Company profile inference could not be confirmed. Retry the same request.')
    } finally {
        await reader.cancel().catch(() => {})
    }
}
