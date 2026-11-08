import { describe, expect, it } from 'vitest'
import { claudeCardCallTiming, decideTurnOrder } from './turn-order-adapters.js'

describe('turn-order adapters', () => {
    it('marks Claude providers call-first and keeps card visibility copy', () => {
        const decision = decideTurnOrder('claude', 'claude-opus-5-5')
        expect(decision.order).toBe('call-first')
        expect(decision.cardTiming).toContain('the card still shows below that message')
        expect(claudeCardCallTiming('claude-sonnet-5-5', 'anthropic')).toContain('below that message')
    })

    it('keeps non-Claude non-GPT models message-first', () => {
        expect(decideTurnOrder('google', 'gemini-3.5-flash').order).toBe('message-first')
    })
})
