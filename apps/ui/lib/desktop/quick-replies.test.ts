import { expect, test } from 'vitest'
import { desktopQuickRepliesOf, desktopQuickReplyInputOf } from './quick-replies'

const part = (replies: unknown, toolName = 'suggest_replies', state = 'input-available') => ({
    type: 'dynamic-tool', toolName, toolCallId: 'suggestions', state, input: { replies },
})

test('reuses original alias handling, normalization and last-valid-call selection', () => {
    const messages = { role: 'assistant', parts: [
        part(['Earlier']), part(['  Find more  ', 'find more', '', 'Export CSV'], 'mcp__rerun__suggest_replies'),
        part(['x'.repeat(41)]),
    ] }
    expect(desktopQuickRepliesOf(messages)).toEqual(['Find more', 'Export CSV'])
    expect(desktopQuickRepliesOf({ ...messages, role: 'user' })).toEqual([])
})

test.each([
    undefined, null, {}, { type: 'text', text: 'Next step' },
    part(['Wrong tool'], 'fs_read'), part(['Still streaming'], 'suggest_replies', 'input-streaming'),
    part([]), part(['A', 'B', 'C', 'D']), part(['x'.repeat(41)]), part([42]),
])('does not project malformed, unrelated or incomplete suggestions: %j', value => {
    expect(desktopQuickReplyInputOf(value)).toBeNull()
})

test('saved projection retains only bounded validated labels, never tool output or extra inputs', () => {
    const original = { ...part(['  Search again  ', 'Open report'], 'rerun__suggest_replies'),
        input: { replies: ['  Search again  ', 'Open report'], credential: 'private' },
        output: { secret: 'private' }, providerMetadata: { token: 'private' },
    }
    expect(desktopQuickReplyInputOf(original)).toEqual({ replies: ['Search again', 'Open report'] })
    expect(desktopQuickReplyInputOf(part(['x'.repeat(40), 'Second', 'Third']))?.replies).toHaveLength(3)
})
