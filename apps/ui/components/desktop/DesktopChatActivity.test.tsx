import { loadMessages } from '@rerun/i18n/messages'
import type { UIMessage } from 'ai'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { desktopMessages } from '@/lib/desktop/locale'
import { desktopSummaryMetadata } from '@/lib/desktop/reasoning-summary'
import { DesktopChatActivity } from './DesktopChatActivity'
import { DesktopLocale } from './DesktopLocale'

const activity = (...parts: UIMessage['parts']) =>
    <DesktopChatActivity agentId="ada" message={{ id: 'reply', role: 'assistant', parts }} />

describe('Mac coworker chat activity', () => {
    it('announces writing with upstream translations', async () => {
        const source = await loadMessages('fr')
        const messages = desktopMessages('fr', source)
        const html = renderToStaticMarkup(<DesktopLocale initial={{ preference: 'fr', locale: 'fr', messages }}>
            {activity({ type: 'text', text: 'Partial reply', state: 'streaming' }, { type: 'data-usage', data: {} })}
        </DesktopLocale>)
        expect(html).toContain(`role="status" class="sr-only">${source.chat.activity.writing}</span>`)
        expect(html).not.toContain('Partial reply')
    })

    it('keeps private reasoning hidden and defers to a public live reasoning row', () => {
        const reasoning = { type: 'reasoning', state: 'streaming', text: 'private provider text' } as const
        const html = renderToStaticMarkup(activity(reasoning))
        expect(html).toContain('role="status" class="sr-only">Thinking...</span>')
        expect(html).not.toContain(reasoning.text)
        expect(renderToStaticMarkup(activity({ ...reasoning, providerMetadata: desktopSummaryMetadata }, { type: 'data-usage', data: {} }))).toBe('')
    })

    it('does not duplicate a running tool, pending approval, or compaction', () => {
        expect(renderToStaticMarkup(activity({ type: 'tool-web_search', toolCallId: 'search', state: 'input-available', input: {} }))).toBe('')
        expect(renderToStaticMarkup(activity({ type: 'tool-web_search', toolCallId: 'search', state: 'approval-requested', input: {}, approval: { id: 'approval' } }))).toBe('')
        expect(renderToStaticMarkup(activity({ type: 'data-compaction', id: 'compaction', data: { status: 'running' } }))).toBe('')
        expect(renderToStaticMarkup(activity(
            { type: 'data-compaction', id: 'compaction', data: { status: 'running' } },
            { type: 'data-compaction', id: 'compaction', data: { status: 'done' } },
        ))).toContain('Thinking...')
    })

    it('names a live child from its progress and ignores malformed progress parts', () => {
        const call = { type: 'tool-call_agent', toolCallId: 'child', state: 'input-available', input: {} } as const
        const html = renderToStaticMarkup(activity(call,
            { type: 'data-delegate', id: 'invalid', data: { tasks: [null] } },
            { type: 'data-call-agent', id: 'child', data: { agentName: 'Reviewer', status: 'running' } },
        ))
        expect(html).toContain('role="status" class="sr-only">Waiting on Reviewer</span>')
        expect(renderToStaticMarkup(activity(call, { type: 'data-call-agent', id: 'child', data: null }))).toBe('')
    })
})
