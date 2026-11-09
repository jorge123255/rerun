import { expect, it } from 'vitest'
import { foremanHistoryParts, safeForemanHistoryLink } from './parts'

it('preserves text, source order, duplicate call identities and deterministic keys', () => {
    const parts = [{ type: 'text', text: 'Before **Markdown**\n' }, { type: 'tool-x', toolCallId: 'same', state: 'output-available', output: 'ok' }, { type: 'text', text: 'After' }, { type: 'tool-x', toolCallId: 'same', state: 'input-available' }, { type: 'future-widget', token: 'NEVER_DISPLAY' }]
    const projected = foremanHistoryParts('message', parts)
    expect(projected.map(p => p.kind)).toEqual(['text', 'tool', 'text', 'tool', 'unknown'])
    expect(projected[0]).toMatchObject({ text: 'Before **Markdown**\n' })
    expect(new Set(projected.map(p => p.key)).size).toBe(parts.length)
    expect(foremanHistoryParts('message', parts)).toEqual(projected)
    expect(JSON.stringify(projected)).not.toContain('NEVER_DISPLAY')
    expect(projected[3]).toMatchObject({ item: { status: 'unknown' } })
})

it('rejects active schemes, relative routes and credentialed links', () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', '/api/desktop/send', 'https://user:pass@example.com', ' https://example.com']) expect(safeForemanHistoryLink(link)).toBeNull()
    expect(safeForemanHistoryLink('https://example.com/docs?q=one')).toBe('https://example.com/docs?q=one')
})

it('only uses historical cards when saved output proves a result', () => {
    const good = { type: 'tool-notify_user', toolCallId: 'n', state: 'output-available', input: { message: 'Saved notification' }, output: 'Notification sent to the user.' }
    expect(foremanHistoryParts('m', [good])[0]?.kind).toBe('card')
    expect(foremanHistoryParts('m', [{ ...good, state: 'output-error', errorText: 'failed' }])[0]?.kind).toBe('tool')
    expect(foremanHistoryParts('m', [{ ...good, output: undefined }])[0]?.kind).not.toBe('card')
})
