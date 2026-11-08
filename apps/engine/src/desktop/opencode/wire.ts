import { DESKTOP_OPENCODE_CREDITS_USED_UP, DESKTOP_OPENCODE_GO_LIMIT, DESKTOP_OPENCODE_MAX_OUTPUT_TOKENS, DESKTOP_OPENCODE_SESSION_HEADER, type DesktopOpencodeModel, type DesktopOpencodeWindow } from '@rerun/contracts'

export type DesktopOpencodeUsage = {
    billing_source?: unknown
    list_cost?: unknown
    tokens?: { cache_read?: unknown; cache_write_5m?: unknown; cache_write_1h?: unknown } | null
}

export type DesktopOpencodeCost = { billingSource: string; cost: number }

const RESET_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })
const WINDOW_NAME: Record<DesktopOpencodeWindow['kind'], string> = { session: '5-hour', weekly: 'weekly', monthly: 'monthly' }

export function desktopOpencodeLimitMessage(window: DesktopOpencodeWindow): string {
    const reset = window.resetsAt ? ` · resets ${RESET_FORMAT.format(new Date(window.resetsAt))}` : ''
    return `${DESKTOP_OPENCODE_GO_LIMIT}: ${WINDOW_NAME[window.kind]} window${reset}`
}

export function findDesktopOpencodeUsage(value: unknown, depth = 0): DesktopOpencodeUsage | undefined {
    if (!value || typeof value !== 'object' || depth > 4) return undefined
    const own = (value as { opencode?: unknown }).opencode
    if (own && typeof own === 'object' && 'billing_source' in own) return own as DesktopOpencodeUsage
    for (const child of Object.values(value as Record<string, unknown>)) {
        const found = findDesktopOpencodeUsage(child, depth + 1)
        if (found) return found
    }
    return undefined
}

const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

export function desktopOpencodeCost(usage: DesktopOpencodeUsage): DesktopOpencodeCost | undefined {
    if (typeof usage.billing_source !== 'string') return undefined
    if (usage.billing_source === 'go') return { billingSource: 'go', cost: 0 }
    const cost = asNumber(usage.list_cost)
    return cost === undefined ? undefined : { billingSource: usage.billing_source, cost }
}

export function desktopOpencodeCacheWrite(usage: DesktopOpencodeUsage): number | undefined {
    const short = asNumber(usage.tokens?.cache_write_5m)
    const long = asNumber(usage.tokens?.cache_write_1h)
    return short === undefined && long === undefined ? undefined : (short ?? 0) + (long ?? 0)
}

function messageOf(text: string): string {
    try {
        const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown }
        const message = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message)
        if (typeof message === 'string' && message) return message
    } catch { /* the text itself */ }
    return text.trim()
}

export function desktopOpencodeErrorEnvelope(status: number, message: string): string {
    return JSON.stringify({ type: 'error', error: { type: 'opencode_error', message, code: status, status: 'OPENCODE_ERROR' } })
}

export function desktopOpencodeRefusalMessage(status: number, body: string, model: DesktopOpencodeModel, spent: DesktopOpencodeWindow | null): string | null {
    const original = messageOf(body)
    if (status === 401) return `OpenCode key refused (401): ${original}`
    if (status === 402) return `${DESKTOP_OPENCODE_CREDITS_USED_UP}: ${original}`
    if (status === 400 && /model is unavailable/i.test(original)) return `Provider returned error: OpenCode no longer offers ${model.label} (${original})`
    if (status === 429 && model.plan === 'go' && spent) return desktopOpencodeLimitMessage(spent)
    return null
}

export type DesktopOpencodeHttpRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

// The id that leaves the box is the upstream id. Google also puts that id in the path.
export function desktopOpencodeHttpRequest(model: DesktopOpencodeModel, apiKey: string, sessionId: string, stream: boolean, userAgent = 'rerun-desktop-opencode/1'): DesktopOpencodeHttpRequest {
    const headers: Record<string, string> = { [DESKTOP_OPENCODE_SESSION_HEADER]: sessionId, 'User-Agent': userAgent, 'Content-Type': 'application/json' }
    const upstream = model.upstreamId
    if (model.wire === 'anthropic') {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = '2023-06-01'
        return { url: `${model.baseUrl}/messages`, headers, body: { model: upstream, max_tokens: Math.min(model.outputLimit, DESKTOP_OPENCODE_MAX_OUTPUT_TOKENS), stream } }
    }
    if (model.wire === 'responses') {
        headers.authorization = `Bearer ${apiKey}`
        return { url: `${model.baseUrl}/responses`, headers, body: { model: upstream, store: false, stream } }
    }
    if (model.wire === 'google') {
        headers['x-goog-api-key'] = apiKey
        const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
        return { url: `${model.baseUrl}/models/${encodeURIComponent(upstream)}:${method}`, headers, body: { contents: [] } }
    }
    headers.authorization = `Bearer ${apiKey}`
    return { url: `${model.baseUrl}/chat/completions`, headers, body: { model: upstream, stream } }
}

export type DesktopOpencodeParsed = {
    text: string
    reasoning: string
    toolNames: string[]
    terminal: 'completed' | 'unknown'
    usage?: DesktopOpencodeUsage
}

function dataEvents(sse: string): unknown[] {
    const events: unknown[] = []
    for (const line of sse.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try { events.push(JSON.parse(data)) } catch { /* skip a torn frame */ }
    }
    return events
}

function pushText(parts: string[], value: unknown) {
    if (typeof value === 'string' && value) parts.push(value)
}

// Normalizes one captured or live SSE body for the four OpenCode wires. A body with no terminal frame is unknown.
export function parseDesktopOpencodeSse(model: DesktopOpencodeModel, sse: string): DesktopOpencodeParsed {
    const events = dataEvents(sse)
    const text: string[] = []
    const reasoning: string[] = []
    const toolNames: string[] = []
    let usage: DesktopOpencodeUsage | undefined
    let terminal = false
    if (sse.includes('data: [DONE]')) terminal = true
    for (const event of events) {
        usage = findDesktopOpencodeUsage(event) ?? usage
        if (!event || typeof event !== 'object') continue
        const record = event as Record<string, unknown>
        if (model.wire === 'chat') {
            const choice = Array.isArray(record.choices) ? record.choices[0] as { delta?: Record<string, unknown>; finish_reason?: string } : undefined
            pushText(reasoning, choice?.delta?.reasoning_content)
            pushText(text, choice?.delta?.content)
            const calls = choice?.delta?.tool_calls
            if (Array.isArray(calls)) for (const call of calls) {
                const name = (call as { function?: { name?: string } }).function?.name
                if (name) toolNames.push(name)
            }
            if (choice?.finish_reason) terminal = true
        } else if (model.wire === 'anthropic') {
            const delta = record.delta as { type?: string; text?: string; thinking?: string } | undefined
            if (delta?.type === 'thinking_delta') pushText(reasoning, delta.thinking)
            if (delta?.type === 'text_delta') pushText(text, delta.text)
            if (record.type === 'message_stop' || record.type === 'message_delta') terminal = true
        } else if (model.wire === 'responses') {
            if (record.type === 'response.output_text.delta') pushText(text, record.delta)
            if (record.type === 'response.completed' || record.type === 'response.incomplete') terminal = true
        } else {
            const candidates = Array.isArray(record.candidates) ? record.candidates : []
            for (const candidate of candidates) {
                const parts = (candidate as { content?: { parts?: { text?: string }[] }; finishReason?: string }).content?.parts ?? []
                for (const part of parts) pushText(text, part.text)
                if ((candidate as { finishReason?: string }).finishReason) terminal = true
            }
        }
    }
    return { text: text.join(''), reasoning: reasoning.join(''), toolNames, terminal: terminal ? 'completed' : 'unknown', usage }
}
