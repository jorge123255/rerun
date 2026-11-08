import { DESKTOP_OPENCODE_MAX_OUTPUT_TOKENS, DESKTOP_OPENCODE_ONE_SHOT_SESSION, desktopOpencodeKeyProblem, desktopOpencodeResultSchema, type DesktopOpencodeDispatch, type DesktopOpencodeModel, type DesktopOpencodeResult } from '@rerun/contracts'
import { desktopOpencodeDispatchModel, refreshDesktopOpencodeCatalog } from './catalog.js'
import { refreshDesktopOpencodeLimits, spentDesktopOpencodeWindow } from './limits.js'
import { desktopOpencodeCost, desktopOpencodeErrorEnvelope, desktopOpencodeHttpRequest, desktopOpencodeRefusalMessage, findDesktopOpencodeUsage, parseDesktopOpencodeSse, type DesktopOpencodeUsage } from './wire.js'

export type DesktopOpencodePrompt = {
    messages?: unknown
    contents?: unknown
    system?: unknown
    tools?: unknown
    maxOutputTokens?: number
}

export type DesktopOpencodeCall = {
    dispatch: DesktopOpencodeDispatch
    apiKey: string | null
    prompt?: DesktopOpencodePrompt
    fetch: typeof fetch
    signal?: AbortSignal
    userAgent?: string
    enabledModelIds?: readonly string[]
    now?: number
}

const result = (value: DesktopOpencodeResult): DesktopOpencodeResult => desktopOpencodeResultSchema.parse(value)

function refused(message: string, code: NonNullable<DesktopOpencodeResult['code']>, sent: boolean): DesktopOpencodeResult {
    return result({ status: 'refused', message, code, sent })
}

function withPrompt(model: DesktopOpencodeModel, body: Record<string, unknown>, prompt: DesktopOpencodePrompt | undefined): Record<string, unknown> {
    if (!prompt) return body
    const next = { ...body }
    if (model.wire === 'google') {
        if (prompt.contents !== undefined) next.contents = prompt.contents
        if (prompt.system !== undefined) next.systemInstruction = prompt.system
        if (prompt.tools !== undefined) next.tools = prompt.tools
        return next
    }
    if (model.wire === 'anthropic') {
        if (prompt.messages !== undefined) next.messages = prompt.messages
        if (prompt.system !== undefined) next.system = prompt.system
        if (prompt.tools !== undefined) next.tools = prompt.tools
        if (prompt.maxOutputTokens !== undefined) next.max_tokens = Math.min(prompt.maxOutputTokens, model.outputLimit, DESKTOP_OPENCODE_MAX_OUTPUT_TOKENS)
        return next
    }
    if (model.wire === 'responses') {
        if (prompt.messages !== undefined) next.input = prompt.messages
        if (prompt.tools !== undefined) next.tools = prompt.tools
        return next
    }
    if (prompt.messages !== undefined) next.messages = prompt.messages
    if (prompt.tools !== undefined) next.tools = prompt.tools
    return next
}

function textOfJson(model: DesktopOpencodeModel, json: unknown): { text: string; usage?: DesktopOpencodeUsage } {
    const usage = findDesktopOpencodeUsage(json)
    if (!json || typeof json !== 'object') return { text: '', usage }
    const record = json as Record<string, unknown>
    if (model.wire === 'chat') {
        const choice = Array.isArray(record.choices) ? record.choices[0] as { message?: { content?: unknown } } : undefined
        return { text: typeof choice?.message?.content === 'string' ? choice.message.content : '', usage }
    }
    if (model.wire === 'anthropic') {
        const blocks = Array.isArray(record.content) ? record.content : []
        return { text: blocks.map(block => (block as { type?: string; text?: string }).type === 'text' ? (block as { text?: string }).text ?? '' : '').join(''), usage }
    }
    if (model.wire === 'responses') return { text: typeof record.output_text === 'string' ? record.output_text : '', usage }
    const candidates = Array.isArray(record.candidates) ? record.candidates : []
    return { text: candidates.flatMap(candidate => ((candidate as { content?: { parts?: { text?: string }[] } }).content?.parts ?? []).map(part => part.text ?? '')).join(''), usage }
}

// Rewrites a provider refusal and, only then, refreshes usage or the catalog. A usage miss does not refuse the key.
export async function settleDesktopOpencodeRefusal(input: {
    status: number
    body: string
    model: DesktopOpencodeModel
    workspaceId: number
    connectionId: string
    requestId: string
    apiKey: string
    fetch: typeof fetch
    signal?: AbortSignal
    userAgent?: string
    enabledModelIds?: readonly string[]
    now?: number
}): Promise<string | null> {
    let spent = input.model.plan === 'go' ? spentDesktopOpencodeWindow(input.workspaceId, input.connectionId) : null
    if (input.status === 429 && input.model.plan === 'go' && !spent && !input.signal?.aborted) {
        await refreshDesktopOpencodeLimits({ workspaceId: input.workspaceId, connectionId: input.connectionId, apiKey: input.apiKey, fetch: input.fetch, signal: input.signal, now: input.now, userAgent: input.userAgent }).catch(() => null)
        spent = spentDesktopOpencodeWindow(input.workspaceId, input.connectionId)
    }
    const message = desktopOpencodeRefusalMessage(input.status, input.body, input.model, spent)
    if (input.status === 400 && message && /no longer offers/i.test(message) && !input.signal?.aborted) {
        await refreshDesktopOpencodeCatalog({
            workspaceId: input.workspaceId,
            requestId: `${input.requestId}:retirement`,
            selectedModelId: input.model.id,
            enabledModelIds: input.enabledModelIds,
            fetch: input.fetch,
            signal: input.signal,
            now: input.now,
            userAgent: input.userAgent,
        }).catch(() => undefined)
    }
    return message
}

export function desktopOpencodeRefusalResponse(status: number, statusText: string, headers: Headers, message: string | null, body: string): Response {
    const next = new Headers(headers)
    next.delete('content-length')
    next.delete('content-encoding')
    if (!message) return new Response(body, { status, statusText, headers: next })
    next.set('content-type', 'application/json')
    return new Response(desktopOpencodeErrorEnvelope(status, message), { status, statusText, headers: next })
}

function codeFor(status: number): NonNullable<DesktopOpencodeResult['code']> {
    if (status === 401) return 'credential'
    if (status === 402) return 'credits'
    if (status === 400) return 'retired'
    if (status === 429) return 'limit'
    return 'transport'
}

// Sends one scoped OpenCode request. Stop before send is cancelled and unsent. A lost terminal frame stays unknown.
export async function executeDesktopOpencode(input: DesktopOpencodeCall): Promise<DesktopOpencodeResult> {
    const dispatch = input.dispatch
    if (input.signal?.aborted) return refused('OpenCode was stopped before the request was sent.', 'cancelled', false)
    const problem = input.apiKey ? desktopOpencodeKeyProblem(input.apiKey) : 'This OpenCode connection has no key. Add it again in AI providers.'
    if (problem) return refused(problem, 'credential', false)
    const resolved = desktopOpencodeDispatchModel(dispatch.workspaceId, dispatch.modelId)
    if (resolved.kind === 'retired') return refused(`OpenCode no longer offers ${dispatch.modelId}. Pick another model.`, 'retired', false)
    if (resolved.kind === 'missing') return refused(`OpenCode does not offer ${dispatch.modelId}. Pick another model.`, 'unavailable', false)
    if (resolved.model.plan === 'console' && !dispatch.consoleEnabled) return refused('Console stays off until you switch it on.', 'console', false)
    if (input.enabledModelIds && !input.enabledModelIds.includes(resolved.model.id)) return refused('Choose a model this connection has switched on.', 'grant', false)

    const request = desktopOpencodeHttpRequest(resolved.model, input.apiKey!, dispatch.sessionId || DESKTOP_OPENCODE_ONE_SHOT_SESSION, dispatch.stream, input.userAgent)
    const body = withPrompt(resolved.model, request.body, input.prompt)
    let response: Response
    try {
        if (input.signal?.aborted) return refused('OpenCode was stopped before the request was sent.', 'cancelled', false)
        response = await input.fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body), redirect: 'error', signal: input.signal })
    } catch (error) {
        const message = input.signal?.aborted ? 'OpenCode stopped after the request left. The outcome was not read back.' : error instanceof Error && error.message ? error.message : 'OpenCode did not answer.'
        return result({ status: 'unknown', message: message.slice(0, 500), code: 'transport', sent: true })
    }

    const raw = await response.text().catch(() => '')
    if (!response.ok) {
        const message = await settleDesktopOpencodeRefusal({
            status: response.status,
            body: raw,
            model: resolved.model,
            workspaceId: dispatch.workspaceId,
            connectionId: dispatch.connectionId,
            requestId: dispatch.requestId,
            apiKey: input.apiKey!,
            fetch: input.fetch,
            signal: input.signal,
            userAgent: input.userAgent,
            enabledModelIds: input.enabledModelIds,
            now: input.now,
        })
        if (message && (response.status === 401 || response.status === 402 || response.status === 400 || (response.status === 429 && resolved.model.plan === 'go'))) {
            return refused(message.slice(0, 500), codeFor(response.status), true)
        }
        return result({ status: 'unknown', message: (message ?? `OpenCode returned ${response.status}.`).slice(0, 500), code: response.status === 429 ? 'unavailable' : 'transport', sent: true })
    }

    if (dispatch.stream) {
        const parsed = parseDesktopOpencodeSse(resolved.model, raw)
        const cost = parsed.usage ? desktopOpencodeCost(parsed.usage) : undefined
        if (parsed.terminal === 'completed' && !input.signal?.aborted) {
            return result({ status: 'saved', message: 'OpenCode finished.', sent: true, text: parsed.text, ...cost })
        }
        if (parsed.terminal === 'completed') return result({ status: 'saved', message: 'OpenCode finished.', sent: true, text: parsed.text, ...cost })
        if (parsed.text) return result({ status: 'partial', message: 'OpenCode stopped after a partial answer.', code: 'transport', sent: true, text: parsed.text, ...cost })
        return result({ status: 'unknown', message: input.signal?.aborted ? 'OpenCode stopped while the answer was still arriving.' : 'OpenCode closed the stream without a terminal frame.', code: 'transport', sent: true, ...cost })
    }

    let json: unknown = null
    try { json = JSON.parse(raw) } catch { json = null }
    if (json === null) return result({ status: 'unknown', message: 'OpenCode returned a body that was not JSON.', code: 'transport', sent: true })
    const once = textOfJson(resolved.model, json)
    return result({ status: 'saved', message: 'OpenCode finished.', sent: true, text: once.text, ...(once.usage ? desktopOpencodeCost(once.usage) : {}) })
}
