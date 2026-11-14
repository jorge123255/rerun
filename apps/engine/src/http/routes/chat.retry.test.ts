import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../../db/schema.js'
import { unansweredRepeat } from './chat.js'

const context = { type: 'text', text: '<now>\n2026-11-14T02:43:00Z\n</now>', providerOptions: { rerun: { context: true } } }
const row = (id: string, role: string, parts: unknown[], authorId: string | null = null) =>
    ({ id, sessionId: 's', role, contentJson: JSON.stringify(parts), toolCallsJson: null, createdAt: '2026-11-14T02:43:00.000Z', authorId, authorName: null, sourcesJson: null }) as MessageRow
const said = (text: string) => [{ type: 'text', text }, context]

describe('a retry of a turn that got no answer', () => {
    it('reuses the stored message when the same words are sent again', () => {
        const rows = [row('a', 'user', said('hello')), row('b', 'assistant', [{ type: 'text', text: 'hi' }]), row('c', 'user', said('create an image of a dog'))]
        expect(unansweredRepeat(rows, 'create an image of a dog')?.id).toBe('c')
    })
    it('stores a new message when the last turn was answered, the words differ, or another person wrote it', () => {
        const answered = [row('a', 'user', said('hello')), row('b', 'assistant', [{ type: 'text', text: 'hi' }])]
        expect(unansweredRepeat(answered, 'hello')).toBeUndefined()
        expect(unansweredRepeat([row('a', 'user', said('hello'))], 'hello again')).toBeUndefined()
        expect(unansweredRepeat([row('a', 'user', said('hello'), 'person-1')], 'hello', 'person-2')).toBeUndefined()
        expect(unansweredRepeat([], 'hello')).toBeUndefined()
    })
    it('does not reuse a message that carried a file or more than its own context', () => {
        expect(unansweredRepeat([row('a', 'user', [{ type: 'text', text: 'hello' }, { type: 'file', data: 'x', mediaType: 'image/png' }])], 'hello')).toBeUndefined()
        expect(unansweredRepeat([row('a', 'user', [{ type: 'text', text: 'hello' }, context, context])], 'hello')).toBeUndefined()
    })
})
