import { describe, expect, it } from 'vitest'
import { desktopForemanRetryOf } from './retry'

const user = (text: string, metadata?: Record<string, unknown>) => ({ id: 'u', role: 'user' as const, parts: [{ type: 'text', text }], ...(metadata && { metadata }) })
const answer = { id: 'a', role: 'assistant' as const, parts: [{ type: 'text', text: 'partial' }] }

describe('desktopForemanRetryOf', () => {
    it('resends the last message the user typed, past a partial answer', () => {
        expect(desktopForemanRetryOf([user('first'), answer, user(' Draft the weekly report '), answer])).toEqual({ text: 'Draft the weekly report' })
    })

    it('offers nothing with no user message, an empty one, files, or a saved decision', () => {
        expect(desktopForemanRetryOf([])).toBeNull()
        expect(desktopForemanRetryOf([answer])).toBeNull()
        expect(desktopForemanRetryOf([user('  ')])).toBeNull()
        expect(desktopForemanRetryOf([user('read this', { documents: [{}] })] as never)).toBeNull()
        expect(desktopForemanRetryOf([user('approved', { savedDecision: {} })])).toBeNull()
        expect(desktopForemanRetryOf([{ id: 'u', role: 'user', parts: [{ type: 'file' }] }])).toBeNull()
    })
})
