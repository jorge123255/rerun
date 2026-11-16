import { APICallError, LoadAPIKeyError, RetryError } from 'ai'
import { ANTHROPIC_KEY_NOT_SCOPED, CONTEXT_WINDOW, OPENAI_API_CREDITS_USED_UP, PROVIDER_API_CREDITS_USED_UP, PROVIDER_OVERLOADED, SUBSCRIPTION_LIMIT, type Provider } from '@rerun/contracts'
import { isRerunBudgetError, RERUN_BUDGET_ERROR_CODE } from './budget-latch.js'

export const RUN_ERROR_CODES = {
    usageLimit: 'provider_usage_limit',
    unauthorized: 'provider_unauthorized',
    authRenewed: 'provider_auth_renewed',
    overloaded: 'provider_overloaded',
    contextWindow: 'provider_context_window',
    turnFailed: 'provider_turn_failed',
    streamIncomplete: 'provider_stream_incomplete',
    refused: 'provider_refused',
    engineRestarted: 'engine_restarted',
} as const

export type RunErrorCode = (typeof RUN_ERROR_CODES)[keyof typeof RUN_ERROR_CODES] | typeof RERUN_BUDGET_ERROR_CODE

// The raw finish reason `openrouterStreamRetryMiddleware` puts on a step whose stream was cut and
// could not be replayed. A finish rather than an error part: `onFinish` is the callback that keeps
// the steps the run had already completed.
export const STREAM_CUT_RAW_REASON = 'stream_cut'

// The message is what the chat classifies as an interrupted run, so the notice offers to pick the
// run back up instead of showing a raw stack.
export class ProviderStreamCutError extends Error {
    constructor() {
        super('the provider ended the turn without a result')
        this.name = 'ProviderStreamCutError'
    }
}

// A request the provider turned down as malformed: the same request will be turned down again, so
// the reason is kept in the message. It still reads "Provider returned error", which is what the chat
// classifies as a refusal.
export class ProviderRefusedError extends Error {
    constructor(reason: string | null) {
        super(reason ? `Provider returned error: ${reason}` : 'Provider returned error')
        this.name = 'ProviderRefusedError'
    }
}

// A 401 on a Claude token the engine itself replaced or let lapse while the run held it: the
// connection is fine, the run was only cut off, and the chat offers to pick it back up.
export class ClaudeSignInRenewedError extends Error {
    constructor() {
        super('interrupted: Claude sign-in renewed during the run')
        this.name = 'ClaudeSignInRenewedError'
    }
}

// The CLI providers report a failed turn as a *finish*, not as an error: codex maps
// `turn/completed status:'failed'` to a plain finish part carrying `usage_limit_exceeded` or
// `context_window_exceeded` as its raw reason, and claude-code does the same with
// `error_during_execution`. Without this table a spent subscription reads as a successful, empty
// turn: the run is stored `done`, a "completed" notification goes out and the curator runs.
const RAW_FINISH_CODES: Record<string, RunErrorCode> = {
    usage_limit_exceeded: RUN_ERROR_CODES.usageLimit,
    context_window_exceeded: RUN_ERROR_CODES.contextWindow,
    error_max_turns: RUN_ERROR_CODES.contextWindow,
    error_during_execution: RUN_ERROR_CODES.turnFailed,
    [STREAM_CUT_RAW_REASON]: RUN_ERROR_CODES.streamIncomplete,
}

export function classifyFinishReason(finishReason: string | undefined, rawFinishReason: string | undefined): RunErrorCode | null {
    if (rawFinishReason && RAW_FINISH_CODES[rawFinishReason]) return RAW_FINISH_CODES[rawFinishReason]
    if (finishReason === 'error') return RUN_ERROR_CODES.turnFailed
    return null
}

// `length` on its own is a genuine `max_tokens` truncation, which is a successful turn. Only a raw
// reason we recognise as a failure turns a finish into an error.
export function isFailedFinish(finishReason: string | undefined, rawFinishReason: string | undefined): boolean {
    return classifyFinishReason(finishReason, rawFinishReason) !== null
}

function errorText(error: unknown): string {
    if (error instanceof Error) return `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`
    return String(error)
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}

// OpenRouter answers a refusal with its own "Provider returned error" and puts what the model provider
// said in `error.metadata.raw`, often a JSON body of its own. The SDK's parsed `data` drops `metadata`,
// so it is read from the raw response body.
export function upstreamReason(error: unknown): string | null {
    if (!APICallError.isInstance(error) || !error.responseBody) return null
    const body = parseJson(error.responseBody) as { error?: { message?: unknown; metadata?: { raw?: unknown } } } | null
    const raw = body?.error?.metadata?.raw
    if (typeof raw === 'string') {
        const nested = parseJson(raw) as { message?: unknown; error?: { message?: unknown } } | null
        const message = nested?.message ?? nested?.error?.message
        return typeof message === 'string' ? message : raw
    }
    const message = body?.error?.message
    return typeof message === 'string' && message !== error.message ? message : null
}

// `@ai-sdk/google` already makes the body's message the error's own, so `upstreamReason` finds
// nothing more in it: the error's message is then the reason, unless it is OpenRouter's bare refusal.
export function refusalReason(error: unknown): string | null {
    const upstream = upstreamReason(error)
    if (upstream) return upstream
    if (!APICallError.isInstance(error) || !error.responseBody) return null
    return /^provider returned error$/i.test(error.message.trim()) ? null : error.message
}

function isInsufficientQuota(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false
    const body = value as { code?: unknown; error?: { code?: unknown } }
    return body.code === 'insufficient_quota' || body.error?.code === 'insufficient_quota'
}

/** A durable, provider-scoped notice. Do not attach raw billing links or error bodies. */
export function apiCreditsMessage(provider: string, error: unknown): string | null {
    const cause = RetryError.isInstance(error) ? error.lastError : error
    const quota = APICallError.isInstance(cause)
        ? isInsufficientQuota(cause.data) || isInsufficientQuota(cause.responseBody ? parseJson(cause.responseBody) : null)
        : isInsufficientQuota(cause)
    const noCredits = /no credits remaining/i.test(errorText(cause))
    if (!quota && !noCredits) return null
    return provider === 'openai' ? OPENAI_API_CREDITS_USED_UP : PROVIDER_API_CREDITS_USED_UP
}

function apiCallErrorCode(error: unknown): RunErrorCode | null {
    if (!APICallError.isInstance(error)) return null
    const data = error.data as { exitCode?: unknown; code?: unknown } | undefined
    if (error.statusCode === 401 || data?.exitCode === 401) return RUN_ERROR_CODES.unauthorized
    if (typeof data?.code === 'string' && /^(401|unauthorized|auth)$/i.test(data.code)) return RUN_ERROR_CODES.unauthorized
    if (error.statusCode === 429) return RUN_ERROR_CODES.overloaded
    if (error.isRetryable && PROVIDER_OVERLOADED.test(errorText(error))) return RUN_ERROR_CODES.overloaded
    return null
}

export function classifyProviderError(provider: Provider, error: unknown): RunErrorCode | null {
    if (provider === 'rerun' && isRerunBudgetError(error)) return RERUN_BUDGET_ERROR_CODE
    if (apiCreditsMessage(provider, error)) return RUN_ERROR_CODES.usageLimit
    const text = `${errorText(error)} ${upstreamReason(error) ?? ''}`
    // Both CLIs surface a spent subscription as free text on a generic error, with no status code
    // and no error kind of their own. Claude Code names the window that ran out rather than saying
    // "usage limit" at all: "You've hit your session limit · resets 3pm".
    if (SUBSCRIPTION_LIMIT.test(text)) return RUN_ERROR_CODES.usageLimit
    if (LoadAPIKeyError.isInstance(error)) return RUN_ERROR_CODES.unauthorized
    // The AI SDK gives up on a retryable status after its own attempts and wraps the last one.
    const fromApiCall = apiCallErrorCode(RetryError.isInstance(error) ? error.lastError : error)
    if (fromApiCall) return fromApiCall
    if (ANTHROPIC_KEY_NOT_SCOPED.test(text)) return RUN_ERROR_CODES.unauthorized
    if (/not logged in|please login|invalid api key|invalid x-api-key|unauthorized|authentication failed|failed to authenticate|authentication_error|invalid bearer token|oauth token has expired|been revoked|no auth credentials|\b401\b/i.test(text)) return RUN_ERROR_CODES.unauthorized
    if (PROVIDER_OVERLOADED.test(text)) return RUN_ERROR_CODES.overloaded
    if (CONTEXT_WINDOW.test(text)) return RUN_ERROR_CODES.contextWindow
    // Checked last: a 400 that says why, a blown context or a bad key, is classified by its reason.
    if (APICallError.isInstance(error) && error.statusCode === 400) return RUN_ERROR_CODES.refused
    return null
}

// A model stream that produced nothing for longer than the stall timeout. Thrown by the retry
// middleware itself, so it is transient by construction.
export class ProviderStreamStalledError extends Error {
    constructor() {
        super('the provider ended the turn without a result: its stream went silent')
        this.name = 'ProviderStreamStalledError'
    }
}

export type TransientStreamKind = 'connection' | 'overloaded' | 'stalled'

// What the network says when a connection dies under a stream. A refused connection and a name
// that does not resolve are left out on purpose: a local model that is not running, or a mistyped
// endpoint, fails the same way on every attempt.
const TRANSIENT_ERRNO = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'ENETRESET', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT'])
const PERMANENT_ERRNO = new Set(['ECONNREFUSED', 'ENOTFOUND', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'])
const TRANSIENT_STATUS = new Set([502, 503, 504, 529])
const DROPPED_CONNECTION = /socket hang up|premature close|other side closed|fetch failed|network error|econnreset|connection (?:was )?(?:reset|closed|terminated|lost|error)|stream (?:was )?(?:closed|ended|terminated) (?:unexpectedly|prematurely|early)|bad gateway|gateway time-?out/i
const NO_ROOM_RIGHT_NOW = /overloaded|at capacity|high demand|service unavailable/i
// Left to the notices that already explain them: waiting a few seconds changes none of these.
const RATE_OR_POLICY = /rate.?limit|too many requests|content.?(?:policy|filter)|policy violation|safety|moderation/i

type ErrorLink = { name?: unknown; code?: unknown; message?: unknown; statusCode?: unknown; status?: unknown; cause?: unknown; lastError?: unknown; errors?: unknown }

// The error, what it wraps and what the SDK's own retries last saw. Bounded, and safe on a cycle.
function errorChain(error: unknown): ErrorLink[] {
    const chain: ErrorLink[] = []
    const seen = new Set<unknown>()
    const visit = (value: unknown): void => {
        if (typeof value !== 'object' || value === null || seen.has(value) || chain.length >= 12) return
        seen.add(value)
        const link = value as ErrorLink
        chain.push(link)
        visit(link.cause)
        visit(link.lastError)
        if (Array.isArray(link.errors)) link.errors.forEach(visit)
    }
    visit(error)
    return chain
}

/**
 * Whether a failed model stream is worth sending again: a dropped connection, a gateway that
 * answered 502/503/504/529, a provider with no room right now, or a stream that went silent.
 * Anything the run already has a notice for (sign-in, credits, a spent plan, a full context, a
 * refusal, a rate limit, a policy refusal) is never transient, whatever else the message says.
 * It says nothing about whether the step can be replayed: the caller knows what the step already did.
 */
export function transientStreamFailure(provider: Provider, error: unknown): TransientStreamKind | null {
    if (error instanceof ProviderStreamStalledError) return 'stalled'
    const chain = errorChain(error)
    if (chain.some(link => link.name === 'AbortError')) return null
    // Kimi, Grok and Devin fail with a fixed code. Only a runner that went away mid-turn is retried:
    // a timeout already took minutes, and the others are answers.
    const subscription = chain.find(link => link.name === 'SubscriptionAcpError')
    if (subscription) return subscription.code === 'closed' ? 'connection' : null
    const code = classifyProviderError(provider, error)
    if (code !== null && code !== RUN_ERROR_CODES.overloaded) return null
    const text = `${typeof error === 'string' ? error : ''} ${chain.map(link => (typeof link.message === 'string' ? link.message : '')).join(' ')} ${upstreamReason(error) ?? ''}`
    if (RATE_OR_POLICY.test(text)) return null
    const statuses = chain.flatMap(link => [link.statusCode, link.status]).filter((status): status is number => typeof status === 'number')
    if (statuses.some(status => status >= 400 && status < 500)) return null
    const codes = chain.map(link => (typeof link.code === 'string' ? link.code.toUpperCase() : ''))
    if (codes.some(errno => PERMANENT_ERRNO.has(errno))) return null
    if (statuses.some(status => TRANSIENT_STATUS.has(status))) return statuses.includes(529) ? 'overloaded' : 'connection'
    if (code === RUN_ERROR_CODES.overloaded || NO_ROOM_RIGHT_NOW.test(text)) return NO_ROOM_RIGHT_NOW.test(text) ? 'overloaded' : null
    if (codes.some(errno => TRANSIENT_ERRNO.has(errno))) return 'connection'
    // Undici reports a body cut mid-stream as the bare word.
    if (chain.some(link => typeof link.message === 'string' && link.message.trim().toLowerCase() === 'terminated')) return 'connection'
    return DROPPED_CONNECTION.test(text) ? 'connection' : null
}
