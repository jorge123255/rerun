import { describe, expect, it } from 'vitest'
import { APICallError, LoadAPIKeyError, RetryError } from 'ai'
import { apiCreditsMessage, classifyFinishReason, classifyProviderError, isFailedFinish, ProviderRefusedError, refusalReason, RUN_ERROR_CODES, STREAM_CUT_RAW_REASON, upstreamReason } from './provider-errors.js'
import { RERUN_BUDGET_ERROR_CODE } from './budget-latch.js'

const apiError = (init: { statusCode?: number; message?: string; data?: unknown; isRetryable?: boolean; responseBody?: string }) =>
    new APICallError({
        message: init.message ?? 'boom',
        url: 'https://provider.test',
        requestBodyValues: {},
        statusCode: init.statusCode,
        data: init.data,
        isRetryable: init.isRetryable,
        responseBody: init.responseBody,
    })

const SCHEMA_REFUSAL = 'tools.0.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level'

it('distinguishes exhausted OpenAI credits from a transient 429', () => {
    const message = 'You exceeded your current quota, please check your plan and billing details.'
    const body = { error: { code: 'insufficient_quota', message } }
    const refused = apiError({ statusCode: 429, message, data: {}, responseBody: JSON.stringify(body) })
    const retried = new RetryError({ message: 'Failed after retries', reason: 'maxRetriesExceeded', errors: [refused] })
    for (const error of [refused, retried, { type: 'error', ...body }, new Error('You have no credits remaining.')]) {
        expect(classifyProviderError('openai', error)).toBe(RUN_ERROR_CODES.usageLimit)
    }
    expect(classifyProviderError('openai', apiError({ statusCode: 429, message }))).toBe(RUN_ERROR_CODES.overloaded)
    expect(classifyProviderError('google', apiError({ statusCode: 429, message }))).toBe(RUN_ERROR_CODES.overloaded)
    expect(apiCreditsMessage('custom', refused)).toBe('Provider API credits used up')
    expect(apiCreditsMessage('openai', retried)).toBe('OpenAI API credits used up')
})

// What OpenRouter answers when the model provider turns a request down.
const openRouterRefusal = (raw: unknown) =>
    apiError({ statusCode: 400, message: 'Provider returned error', responseBody: JSON.stringify({ error: { message: 'Provider returned error', code: 400, metadata: { raw, provider_name: 'Anthropic' } } }) })

describe('classifyFinishReason', () => {
    it('reads a spent subscription off the raw finish reason', () => {
        expect(classifyFinishReason('length', 'usage_limit_exceeded')).toBe(RUN_ERROR_CODES.usageLimit)
    })

    it('reads a blown context window off the raw finish reason', () => {
        expect(classifyFinishReason('length', 'context_window_exceeded')).toBe(RUN_ERROR_CODES.contextWindow)
        expect(classifyFinishReason('length', 'error_max_turns')).toBe(RUN_ERROR_CODES.contextWindow)
    })

    it('reads a stream cut short off the raw finish reason', () => {
        expect(classifyFinishReason('error', STREAM_CUT_RAW_REASON)).toBe(RUN_ERROR_CODES.streamIncomplete)
    })

    it('treats a generic failed turn as an error even without a raw reason', () => {
        expect(classifyFinishReason('error', undefined)).toBe(RUN_ERROR_CODES.turnFailed)
        expect(classifyFinishReason('error', 'error_during_execution')).toBe(RUN_ERROR_CODES.turnFailed)
    })

    // A real max_tokens truncation is a successful turn; treating it as a failure would mark every
    // long answer as an error.
    it('leaves a bare length truncation alone', () => {
        expect(classifyFinishReason('length', 'max_tokens')).toBeNull()
        expect(isFailedFinish('length', 'max_tokens')).toBe(false)
        expect(isFailedFinish('stop', 'stop')).toBe(false)
    })
})

describe('classifyProviderError', () => {
    it('matches the claude usage limit message', () => {
        expect(classifyProviderError('claude', new Error('Claude AI usage limit reached|1750000000'))).toBe(RUN_ERROR_CODES.usageLimit)
    })

    // Claude Code names the window that ran out instead of saying "usage limit": these are the four
    // sentences it builds, one per rate limit type.
    it('matches the window claude code names when a plan runs out', () => {
        expect(classifyProviderError('claude', new Error("You've hit your session limit · resets 3pm"))).toBe(RUN_ERROR_CODES.usageLimit)
        expect(classifyProviderError('claude', new Error("You've hit your weekly limit · resets Nov 20, 3pm"))).toBe(RUN_ERROR_CODES.usageLimit)
        expect(classifyProviderError('claude', new Error("You've hit your Opus limit · resets 3pm"))).toBe(RUN_ERROR_CODES.usageLimit)
        expect(classifyProviderError('claude', new Error("You've hit your Sonnet limit"))).toBe(RUN_ERROR_CODES.usageLimit)
    })

    // Read off the failed runs of real boxes: none of them carried an error code, so the chat showed
    // the raw text with nothing to click.
    it('matches a model the plan does not include, and a spent plan worded differently', () => {
        expect(classifyProviderError('claude', apiError({ message: 'Fable 5.1 requires usage credits. Switch to another model to continue.' }))).toBe(RUN_ERROR_CODES.usageLimit)
        expect(classifyProviderError('claude', apiError({ message: "You're out of usage credits. Switch to another model to continue." }))).toBe(RUN_ERROR_CODES.usageLimit)
        expect(classifyProviderError('claude', apiError({ message: "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/admin-settings/usage" }))).toBe(RUN_ERROR_CODES.usageLimit)
        expect(
            classifyProviderError('codex', new Error('{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-astra\' model is not supported when using Codex with a ChatGPT account."}}'))
        ).toBe(RUN_ERROR_CODES.usageLimit)
        expect(classifyProviderError('codex', new Error('unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it.'))).toBe(RUN_ERROR_CODES.usageLimit)
        expect(classifyProviderError('codex', new Error("You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 4:44 PM."))).toBe(RUN_ERROR_CODES.usageLimit)
    })

    it('matches an expired CLI login', () => {
        expect(classifyProviderError('claude', new LoadAPIKeyError({ message: 'Authentication failed. Ensure Claude CLI is logged in.' }))).toBe(RUN_ERROR_CODES.unauthorized)
        expect(classifyProviderError('codex', apiError({ statusCode: 401 }))).toBe(RUN_ERROR_CODES.unauthorized)
        expect(classifyProviderError('codex', apiError({ data: { exitCode: 401 } }))).toBe(RUN_ERROR_CODES.unauthorized)
        expect(classifyProviderError('claude', new Error('Failed to authenticate. API Error: 401 Invalid bearer token'))).toBe(RUN_ERROR_CODES.unauthorized)
        expect(classifyProviderError('openrouter', new Error('No auth credentials found'))).toBe(RUN_ERROR_CODES.unauthorized)
    })

    it('matches an overloaded upstream', () => {
        expect(classifyProviderError('anthropic', apiError({ statusCode: 429 }))).toBe(RUN_ERROR_CODES.overloaded)
        expect(classifyProviderError('claude', new Error('Claude is overloaded, try again'))).toBe(RUN_ERROR_CODES.overloaded)
    })

    it('matches a model the provider has no room for right now', () => {
        expect(classifyProviderError('codex', new Error('Selected model is at capacity. Please try a different model.'))).toBe(RUN_ERROR_CODES.overloaded)
        expect(classifyProviderError('codex', new Error('exceeded retry limit, last status: 429 Too Many Requests'))).toBe(RUN_ERROR_CODES.overloaded)
    })

    it('delegates the managed budget to the budget latch', () => {
        expect(classifyProviderError('rerun', new Error(`AI_APICallError: ${RERUN_BUDGET_ERROR_CODE}`))).toBe(RERUN_BUDGET_ERROR_CODE)
        // Only the managed provider bills the workspace budget.
        expect(classifyProviderError('openai', new Error(`AI_APICallError: ${RERUN_BUDGET_ERROR_CODE}`))).toBeNull()
    })

    it('reads an overloaded provider through the retries the AI SDK gave up on', () => {
        const highDemand = 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'
        const lastError = apiError({ statusCode: 503, message: highDemand, isRetryable: true })
        const retried = new RetryError({ message: `Failed after 3 attempts. Last error: ${highDemand}`, reason: 'maxRetriesExceeded', errors: [lastError, lastError, lastError] })
        expect(classifyProviderError('google', retried)).toBe(RUN_ERROR_CODES.overloaded)
        const rateLimited = apiError({ statusCode: 429, message: 'Resource exhausted', isRetryable: true })
        expect(classifyProviderError('google', new RetryError({ message: 'Failed after 3 attempts.', reason: 'maxRetriesExceeded', errors: [rateLimited] }))).toBe(RUN_ERROR_CODES.overloaded)
    })

    it('leaves an unrecognised failure unclassified', () => {
        expect(classifyProviderError('openai', new Error('ECONNRESET'))).toBeNull()
    })

    it('reads a 400 as a refusal, unless its reason says otherwise', () => {
        expect(classifyProviderError('rerun', openRouterRefusal(JSON.stringify({ message: SCHEMA_REFUSAL })))).toBe(RUN_ERROR_CODES.refused)
        expect(classifyProviderError('openai', apiError({ statusCode: 400 }))).toBe(RUN_ERROR_CODES.refused)
        expect(classifyProviderError('rerun', openRouterRefusal(JSON.stringify({ message: 'prompt is too long: 210000 tokens > 200000 maximum' })))).toBe(RUN_ERROR_CODES.contextWindow)
        expect(classifyProviderError('google', apiError({ statusCode: 400, message: 'Invalid API key' }))).toBe(RUN_ERROR_CODES.unauthorized)
    })
})

describe('upstreamReason', () => {
    it("reads the model provider's message out of OpenRouter's metadata", () => {
        expect(upstreamReason(openRouterRefusal(JSON.stringify({ message: SCHEMA_REFUSAL })))).toBe(SCHEMA_REFUSAL)
        expect(upstreamReason(openRouterRefusal(JSON.stringify({ type: 'error', error: { message: SCHEMA_REFUSAL } })))).toBe(SCHEMA_REFUSAL)
        expect(upstreamReason(openRouterRefusal('plain text refusal'))).toBe('plain text refusal')
    })

    it('falls back to the error message of the body when it says more than the error', () => {
        expect(upstreamReason(apiError({ statusCode: 400, message: 'Bad Request', responseBody: JSON.stringify({ error: { message: 'max_tokens is too large' } }) }))).toBe('max_tokens is too large')
        expect(upstreamReason(apiError({ statusCode: 400, message: 'Bad Request', responseBody: JSON.stringify({ error: { message: 'Bad Request' } }) }))).toBeNull()
    })

    it('has nothing to say without a readable body', () => {
        expect(upstreamReason(apiError({ statusCode: 400 }))).toBeNull()
        expect(upstreamReason(apiError({ statusCode: 400, responseBody: '<html>502</html>' }))).toBeNull()
        expect(upstreamReason(new Error('Provider returned error'))).toBeNull()
    })
})

describe('refusalReason', () => {
    it("keeps Gemini's reason, which the Google provider already made the error's own message", () => {
        const reason = "Invalid value at 'tools[0].function_declarations[27].parameters.properties[1].value.enum[0]' (TYPE_STRING), true"
        const refusal = apiError({ statusCode: 400, message: reason, responseBody: JSON.stringify({ error: { code: 400, message: reason, status: 'INVALID_ARGUMENT' } }) })
        expect(classifyProviderError('google', refusal)).toBe(RUN_ERROR_CODES.refused)
        expect(refusalReason(refusal)).toBe(reason)
    })

    it("prefers the model provider's message, and never repeats OpenRouter's bare refusal", () => {
        expect(refusalReason(openRouterRefusal(JSON.stringify({ message: SCHEMA_REFUSAL })))).toBe(SCHEMA_REFUSAL)
        expect(refusalReason(apiError({ statusCode: 400, message: 'Provider returned error', responseBody: JSON.stringify({ error: { message: 'Provider returned error' } }) }))).toBeNull()
        expect(refusalReason(apiError({ statusCode: 400 }))).toBeNull()
    })
})

describe('ProviderRefusedError', () => {
    it('keeps the words the chat classifies, with the reason after them', () => {
        expect(new ProviderRefusedError(SCHEMA_REFUSAL).message).toBe(`Provider returned error: ${SCHEMA_REFUSAL}`)
        expect(new ProviderRefusedError(null).message).toBe('Provider returned error')
    })
})
