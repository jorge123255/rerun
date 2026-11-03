import type { ModelMessage } from 'ai'
import { expect, it } from 'vitest'
import { desktopSourceRows } from './desktop-source-rows.js'

it('keeps a source-only step before the following step when both start at the same model message', () => {
    const first = { type: 'source' as const, sourceType: 'url' as const, id: '1', url: 'https://example.org/first' }
    const next = { ...first, id: '2', url: 'https://example.org/next' }
    const messages: ModelMessage[] = [{ role: 'assistant', content: 'Next step' }]
    const rows = desktopSourceRows(messages, [
        { sources: [first], response: { messages: [] } },
        { sources: [next], response: { messages } },
    ])
    expect(rows).toEqual([
        { message: { role: 'assistant', content: [] }, sources: [{ type: 'source-url', sourceId: '1', url: first.url }] },
        { message: messages[0], sources: [{ type: 'source-url', sourceId: '2', url: next.url }] },
    ])
    expect(messages).toHaveLength(1)
})
