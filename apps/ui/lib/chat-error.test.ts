import { describe, expect, it } from 'vitest'
import { chatErrorTitle, classifyChatError, describeSubscriptionLimit, friendlyError, isBudgetExhausted, stripErrorPrefix, installInFlightOf, isAnthropicKeyNotScoped, teammateRunOf, unwrapChatError } from './chat-error'

describe('unwrapChatError', () => {
    it('reads the error field of a JSON envelope', () => {
        expect(unwrapChatError('{"error":"Engine error: 502 upstream down"}')).toBe('Engine error: 502 upstream down')
    })

    it('keeps a plain message as-is', () => {
        expect(unwrapChatError('Failed to fetch')).toBe('Failed to fetch')
    })

    it('keeps a JSON body that carries no error field', () => {
        expect(unwrapChatError('{"status":"ko"}')).toBe('{"status":"ko"}')
    })

    it('keeps a truncated JSON body', () => {
        expect(unwrapChatError('{"error":"Engine err')).toBe('{"error":"Engine err')
    })

    it('normalizes an absent message to an empty string', () => {
        expect(unwrapChatError(undefined)).toBe('')
        expect(unwrapChatError('   ')).toBe('')
    })

    it('preserves the budget marker for isBudgetExhausted', () => {
        expect(isBudgetExhausted(unwrapChatError('{"error":"rerun_budget_exhausted"}'))).toBe(true)
    })
})

describe('friendlyError', () => {
    it('falls back to a generic message when the error carries no text', () => {
        expect(friendlyError('')).toBe('Something went wrong. Try sending your message again.')
    })

    it('humanizes the budget marker', () => {
        expect(friendlyError('rerun_budget_exhausted')).toContain('Rerun credits used up')
    })

    it('passes any other message through', () => {
        expect(friendlyError('Missing message text')).toBe('Missing message text')
    })

    it('drops the AI SDK class name the engine stored', () => {
        expect(friendlyError('AI_APICallError: fetch failed')).toBe('fetch failed')
    })
})

describe('stripErrorPrefix', () => {
    it('removes the class name String(error) put in front', () => {
        expect(stripErrorPrefix('AI_APICallError: fetch failed')).toBe('fetch failed')
        expect(stripErrorPrefix('Error: ECONNRESET')).toBe('ECONNRESET')
        expect(stripErrorPrefix('Error: {"type":"error","status":400,"error":{"message":"The model is gone."}}')).toBe('The model is gone.')
    })

    it('leaves a message that never had one', () => {
        expect(stripErrorPrefix('Missing message text')).toBe('Missing message text')
    })
})

describe('classifyChatError', () => {
    // The engine flattens the provider error into `runs.error`, so these are the strings the two
    // CLI providers actually produce when a subscription runs out or a login expires.
    it('recognises a spent subscription from either CLI', () => {
        expect(classifyChatError('Error: Claude AI usage limit reached|1750000000')).toBe('usage_limit')
        expect(classifyChatError('Error: usage_limit_exceeded')).toBe('usage_limit')
    })

    // Claude Code stopped saying "usage limit" and now names the window that ran out. Without these
    // the sentence fell through to `generic` and the chat printed the raw provider stack.
    it('recognises every window claude code names', () => {
        expect(classifyChatError("AI_APICallError: You've hit your session limit · resets 3pm")).toBe('usage_limit')
        expect(classifyChatError("AI_APICallError: You've hit your weekly limit · resets Nov 20, 3pm")).toBe('usage_limit')
        expect(classifyChatError("AI_APICallError: You've hit your Opus limit · resets 3pm")).toBe('usage_limit')
        expect(classifyChatError("AI_APICallError: You've hit your Sonnet limit")).toBe('usage_limit')
    })

    it('recognises a connection that needs signing in again', () => {
        expect(classifyChatError('LoadAPIKeyError: Authentication failed. Ensure Codex CLI is logged in.')).toBe('unauthorized')
        expect(classifyChatError('AI_LoadAPIKeyError: Failed to authenticate. API Error: 401 Invalid bearer token')).toBe('unauthorized')
        expect(classifyChatError('OAuth token has expired or been revoked (401).')).toBe('unauthorized')
        expect(classifyChatError('No auth credentials found')).toBe('unauthorized')
        expect(classifyChatError('AI_LoadAPIKeyError: Failed to authenticate. API Error: 401 OAuth access token has been revoked.')).toBe('unauthorized')
    })

    // OpenRouter's sentence when the model provider behind it refuses the request: the same request
    // fails the same way on every retry, so the run stopped as `generic` with nothing to click.
    it('recognises a request the model provider refused', () => {
        expect(classifyChatError('AI_APICallError: Provider returned error')).toBe('provider_error')
        expect(classifyChatError('ProviderRefusedError: Provider returned error: tools.0.custom.input_schema: invalid')).toBe('provider_error')
    })

    // The engine keeps the provider's reason in the run's error for the logs; the chat says what to do.
    it('tells the user a refusal will repeat, without the technical reason', () => {
        const message = friendlyError('ProviderRefusedError: Provider returned error: tools.0.custom.input_schema: invalid')
        expect(message).toContain('sending it again will get the same answer')
        expect(message).not.toContain('input_schema')
    })

    // Codex's own sentence when the model has no room for the request: it used to fall through to
    // `generic`, a notice with nothing to click.
    it('recognises a model at capacity as an overloaded provider', () => {
        expect(classifyChatError('Error: Selected model is at capacity. Please try a different model.')).toBe('overloaded')
        expect(classifyChatError('Error: exceeded retry limit, last status: 429 Too Many Requests')).toBe('overloaded')
        expect(classifyChatError('Message failed: AI_RetryError: Failed after 3 attempts. Last error: This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.')).toBe('overloaded')
    })

    // The engine codes it `provider_context_window`, but what reaches the chat is the provider's
    // sentence. It used to fall through to `generic` and get offered a retry that hits the same wall.
    it('recognises a conversation that no longer fits the model', () => {
        expect(classifyChatError('AI_APICallError: prompt is too long: 213456 tokens > 200000 maximum')).toBe('context_window')
        expect(classifyChatError('Error: This request exceeds the context window of the model.')).toBe('context_window')
        expect(friendlyError('AI_APICallError: prompt is too long: 213456 tokens > 200000 maximum')).toContain('larger context window')
    })

    it('tells a model at capacity apart from an overloaded provider', () => {
        expect(friendlyError('Error: Selected model is at capacity. Please try a different model.')).toBe('This model has no room right now. Try again in a moment or pick another model.')
        expect(friendlyError('Error: exceeded retry limit, last status: 429 Too Many Requests')).toBe('The provider is overloaded right now. Try again in a moment.')
    })

    it('recognises a run a restart cut short', () => {
        expect(classifyChatError('interrupted: engine restarted')).toBe('interrupted')
    })

    it('recognises a run whose Claude sign-in the engine renewed under it', () => {
        expect(classifyChatError('ClaudeSignInRenewedError: interrupted: Claude sign-in renewed during the run')).toBe('interrupted')
        expect(friendlyError('ClaudeSignInRenewedError: interrupted: Claude sign-in renewed during the run')).toContain('cut off')
    })

    it('recognises the conversation the engine refused to take a second run on', () => {
        expect(classifyChatError('run_in_flight')).toBe('run_in_flight')
    })

    it('leaves anything it does not know as generic', () => {
        expect(classifyChatError('Error: ECONNRESET')).toBe('generic')
        expect(classifyChatError('')).toBe('generic')
    })
})

describe('friendlyError, beyond the budget', () => {
    it('replaces a classified provider stack with something actionable', () => {
        expect(friendlyError('Error: Claude AI usage limit reached|1750000000')).toContain('Your Claude plan')
        expect(friendlyError('interrupted: engine restarted')).toContain('cut off')
    })

    it('passes an unrecognised message through, minus the class name', () => {
        expect(friendlyError('Error: ECONNRESET')).toBe('ECONNRESET')
    })
})

describe('describeSubscriptionLimit', () => {
    it('names the claude window that ran out', () => {
        expect(describeSubscriptionLimit("You've hit your session limit · resets 3pm")).toEqual({ plan: 'claude', scope: 'session', resetsAt: '3pm' })
        expect(describeSubscriptionLimit("You've hit your weekly limit")).toEqual({ plan: 'claude', scope: 'weekly' })
        expect(describeSubscriptionLimit("You've hit your Opus limit")).toEqual({ plan: 'claude', scope: 'model', modelName: 'Opus' })
    })

    // codex throws its server's message away and keeps only the raw finish reason, which is exactly
    // what tells the two CLIs apart: claude-code never emits that marker.
    it('reads a bare codex finish reason as the ChatGPT plan', () => {
        expect(describeSubscriptionLimit('Error: usage_limit_exceeded')).toEqual({ plan: 'chatgpt', scope: 'session' })
    })

    // The sentences real boxes failed on, none of which the chat used to name.
    it('names a model the plan does not include', () => {
        expect(describeSubscriptionLimit('AI_APICallError: Fable 5.1 requires usage credits. Switch to another model to continue.')).toEqual({ plan: 'claude', scope: 'not_in_plan', modelName: 'Fable 5.1' })
        expect(describeSubscriptionLimit('Error: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-astra\' model is not supported when using Codex with a ChatGPT account."}}')).toEqual({
            plan: 'chatgpt',
            scope: 'not_in_plan',
            modelName: 'GPT-6 Astra',
        })
    })

    it('tells spent credits and an organization cap apart from a usage window', () => {
        expect(describeSubscriptionLimit("AI_APICallError: You're out of usage credits. Switch to another model to continue.")).toEqual({ plan: 'claude', scope: 'credits' })
        expect(describeSubscriptionLimit("AI_APICallError: You've hit your org's monthly spend limit · ask your admin to raise it · your session limit resets 3pm")).toEqual({ plan: 'claude', scope: 'spend' })
    })

    it('keeps the time the plan refills', () => {
        expect(describeSubscriptionLimit("AI_APICallError: You've hit your weekly limit · resets Oct 12, 3am (UTC)")).toEqual({ plan: 'claude', scope: 'weekly', resetsAt: 'Oct 12, 3am (UTC)' })
        expect(describeSubscriptionLimit("Error: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:44 PM.")).toEqual({
            plan: 'chatgpt',
            scope: 'session',
            resetsAt: '4:44 PM',
        })
        expect(friendlyError("AI_APICallError: You've hit your session limit · resets 6:50pm (UTC)")).toContain('It refills at 6:50pm (UTC)')
    })

    it('falls back to a plan-less description when nothing names a vendor', () => {
        expect(describeSubscriptionLimit('Error: quota exceeded')).toEqual({ plan: null, scope: 'session' })
    })

    it('says whose plan is out rather than "this subscription"', () => {
        expect(friendlyError("AI_APICallError: You've hit your session limit · resets 3pm")).toContain('Your Claude plan')
        expect(friendlyError('Error: usage_limit_exceeded')).toContain('Your ChatGPT plan')
    })
})

describe('an Anthropic API key (upstream #250, RER-124)', () => {
    // What an Anthropic API key on an account with no credit stored as the run's error, before and
    // after the engine read it as a spent quota.
    it('names an Anthropic API account out of credits', () => {
        const noCredit = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'
        for (const stored of [`Message failed: ProviderRefusedError: Provider returned error: ${noCredit}`, `Message failed: AI_APICallError: ${noCredit}`]) {
            expect(classifyChatError(stored)).toBe('usage_limit')
            expect(describeSubscriptionLimit(stored)).toEqual({ plan: 'anthropic', scope: 'credits' })
            expect(chatErrorTitle('usage_limit', stored)).toBe('Anthropic API credits used up')
            expect(friendlyError(stored)).toBe('Your Anthropic API account has no credits left. Add credits in the Anthropic Console under Billing, or switch this coworker to another model.')
        }
    })

    // A key made for every workspace of its organization, which no run can use.
    it('says an Anthropic key scoped to no workspace has to be replaced', () => {
        const stored = 'Message failed: ProviderRefusedError: Provider returned error: This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.'
        expect(classifyChatError(stored)).toBe('unauthorized')
        expect(chatErrorTitle('unauthorized', stored)).toBe('Anthropic key not tied to a workspace')
        expect(friendlyError(stored)).toBe('This key works across every workspace of its Anthropic organization. Create a key inside one workspace in the Anthropic Console, then reconnect.')
        expect(isAnthropicKeyNotScoped('unauthorized', stored)).toBe(true)
        expect(isAnthropicKeyNotScoped('unauthorized', 'AI_APICallError: invalid x-api-key')).toBe(false)
    })
})

describe('chatErrorTitle', () => {
    const titleOf = (message: string) => chatErrorTitle(classifyChatError(message), message)

    it('names an expired OAuth token as a signed-out connection', () => {
        expect(titleOf('AI_LoadAPIKeyError: Failed to authenticate. API Error: 401 OAuth access token has expired.')).toBe('Connection signed out')
    })

    it('names the plan and window of a spent subscription', () => {
        expect(titleOf("AI_APICallError: You've hit your session limit · resets 3pm")).toBe('Claude session limit reached')
    })

    it('names the model a plan does not include', () => {
        expect(titleOf('AI_APICallError: Fable 5.1 requires usage credits. Switch to another model to continue.')).toBe("Fable 5.1 isn't in your Claude plan")
    })

    it('says the model could not answer when its provider refused the request', () => {
        expect(titleOf('AI_APICallError: Provider returned error')).toBe('The model could not answer')
    })

    it('says the model is at capacity rather than the whole provider overloaded', () => {
        expect(titleOf('Error: Selected model is at capacity. Please try a different model.')).toBe('Model at capacity')
        expect(titleOf('Error: exceeded retry limit, last status: 429 Too Many Requests')).toBe('Provider overloaded')
    })

    it('names a conversation that outgrew the model', () => {
        expect(titleOf('AI_APICallError: prompt is too long: 213456 tokens > 200000 maximum')).toBe('Conversation too long')
    })

    it('gives a generic error no headline of its own', () => {
        expect(titleOf('AI_APICallError: Connection closed by the provider before the turn started.')).toBeNull()
    })
})

describe('teammateRunOf', () => {
    it('names the run a teammate holds the conversation with', () => {
        expect(teammateRunOf('{"error":"run_in_flight","runId":"r1","startedAt":null,"heldByTeammate":true}')).toEqual({ runId: 'r1' })
    })

    it('is null for a run this person started, and for anything that is not that refusal', () => {
        expect(teammateRunOf('{"error":"run_in_flight","runId":"r1","heldByTeammate":false}')).toBeNull()
        expect(teammateRunOf('Failed to fetch')).toBeNull()
    })
})

describe('installInFlightOf', () => {
    it('names the conversation the install already runs in', () => {
        expect(installInFlightOf('{"error":"install_in_flight","sessionId":"s1"}')).toEqual({ sessionId: 's1' })
    })

    it('is null for any other refusal', () => {
        expect(installInFlightOf('{"error":"run_in_flight","runId":"r1"}')).toBeNull()
        expect(installInFlightOf('{"error":"install_in_flight","sessionId":null}')).toBeNull()
        expect(installInFlightOf('Failed to fetch')).toBeNull()
    })
})
