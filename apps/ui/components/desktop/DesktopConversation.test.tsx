import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { generalTabUid } from '@/lib/desktop/general-threads'
import { englishDesktopLanguage } from '@/lib/desktop/locale'
import { DesktopLocale } from './DesktopLocale'
import { DesktopConversation } from './DesktopConversation'

const agent = { id: 'local-agent-1', name: 'Researcher', description: 'Finds answers', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
const chat = vi.hoisted(() => ({ messages: [] as UIMessage[], status: 'ready' }))
vi.mock('@ai-sdk/react', () => ({ useChat: () => chat }))

describe('DesktopConversation', () => {
    it('keeps history actions and the composer reachable at narrow widths', () => {
        const html = renderToString(<DesktopConversation
            agent={agent}
            sessionId="session-1"
            sessions={[{ id: 'session-1', agentId: agent.id, title: 'First conversation', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]}
            onSelectSession={vi.fn()}
            onChatSession={vi.fn()}
            onClosePanel={vi.fn()}
            modelLabel="test-model"
            onOpenModelSettings={vi.fn()}
        />)
        expect(html).toContain('aria-label="Coworker card"')
        expect(html).toContain('aria-label="Close panel"')
        expect(html).toContain('Conversation history')
        expect(html).toContain('First conversation')
        expect(html).toContain('data-slot="desktop-composer"')
        expect(html).toMatch(/role="status"[^>]*>.*?Loading<\/span>/)
        expect(html).toContain('desktop-message')
        expect(html).toContain('Reply in First conversation...')
    })

    it('hangs a thread card in General with the opening message', () => {
        const html = renderToString(<DesktopConversation
            agent={agent}
            sessionId={null}
            tabUid={generalTabUid(agent.id)}
            sessions={[
                { id: 'general-row', agentId: agent.id, title: 'General', createdAt: '2026-11-08T09:00:00.000Z', updatedAt: '2026-11-08T09:00:00.000Z', kind: 'general', firstMessage: null },
                { id: 'thread-row', agentId: agent.id, title: 'Signup drop', createdAt: '2026-11-08T10:00:00.000Z', updatedAt: '2026-11-08T10:00:00.000Z', kind: 'thread', firstMessage: 'Why did signups drop?' },
            ]}
            onSelectSession={vi.fn()}
            onChatSession={vi.fn()}
        />)
        expect(html).toContain('data-testid="desktop-thread-branch"')
        expect(html).toContain('data-thread-row="thread-row"')
        expect(html).toContain('Why did signups drop?')
        expect(html).toContain('Signup drop')
        expect(html).toContain('Message Researcher...')
    })

    it('retains a thread anchored to a routine divider in General', () => {
        chat.messages = [{
            id: 'routine-message', role: 'user',
            metadata: { createdAt: '2026-11-08T10:00:00.000Z', scheduledRun: { slug: 'daily', name: 'Daily notes' } },
            parts: [{ type: 'text', text: 'Read the notes.' }],
        }]
        try {
            const html = renderToString(<DesktopConversation agent={agent} sessionId={null} tabUid={generalTabUid(agent.id)}
                sessions={[{ id: 'following-thread', agentId: agent.id, title: 'Follow-up', createdAt: '2026-11-08T10:01:00.000Z',
                    updatedAt: '2026-11-08T10:01:00.000Z', kind: 'thread', firstMessage: 'What did we find?' }]}
                onSelectSession={vi.fn()} onChatSession={vi.fn()} />)
            expect(html).toContain('Scheduled run')
            expect(html).toContain('data-thread-row="following-thread"')
            expect(html.indexOf('data-thread-row="following-thread"')).toBeGreaterThan(html.indexOf('Scheduled run'))
        } finally { chat.messages = [] }
    })

    it('marks saved chat breaks with localized timestamps and leaves legacy times blank', () => {
        const first = new Date(2024, 0, 2, 9, 0).toISOString()
        const near = new Date(2024, 0, 2, 9, 5).toISOString()
        const resumed = new Date(2024, 0, 2, 10, 5).toISOString()
        chat.messages = [
            { id: 'engine-legacy', role: 'user', metadata: { createdAt: 'unknown' }, parts: [{ type: 'text', text: 'Legacy note.' }] },
            { id: 'engine-first', role: 'user', metadata: { createdAt: first }, parts: [{ type: 'text', text: 'First dated note.' }] },
            { id: 'engine-near', role: 'assistant', metadata: { createdAt: near }, parts: [{ type: 'text', text: 'A quick answer.' }] },
            { id: 'engine-resumed', role: 'user', metadata: { createdAt: resumed }, parts: [{ type: 'text', text: 'Back again.' }] },
        ]
        try {
            const html = renderToString(<DesktopLocale initial={{ ...englishDesktopLanguage, locale: 'fr' }}>
                <DesktopConversation agent={agent} sessionId={null} sessions={[]} onSelectSession={vi.fn()} onChatSession={vi.fn()} />
            </DesktopLocale>)
            expect([...html.matchAll(/<time dateTime="([^"]+)"/g)].map(match => match[1])).toEqual([first, resumed])
            expect(html).toContain('2 janv. 2024')
            expect(html.indexOf('Legacy note.')).toBeLessThan(html.indexOf(first))
            expect(html.indexOf('A quick answer.')).toBeLessThan(html.indexOf(resumed))
        } finally { chat.messages = [] }
    })

    it('renders only marked Codex summaries as upstream running and settled reasoning steps', () => {
        const render = () => renderToString(<DesktopConversation agent={agent} sessionId={null} sessions={[]} onChatSession={vi.fn()} onSelectSession={vi.fn()} />)
        chat.messages = [{ id: 'answer', role: 'assistant', parts: [
            { type: 'reasoning', text: 'Private trace' },
            { type: 'reasoning', text: 'Legacy mixed block', providerMetadata: { 'codex-app-server': { isSummary: true } } },
            { type: 'reasoning', text: 'Comparing the options.', state: 'streaming', providerMetadata: { 'codex-app-server': { isPublicSummary: true, encrypted: 'Opaque bytes' } } },
        ] }]
        try {
            chat.status = 'streaming'
            const live = render()
            expect(live).toContain('>Thinking<')
            chat.status = 'ready'
            const saved = render()
            expect(saved).not.toContain('>Thinking<')
            for (const html of [live, saved]) {
                expect(html).toContain('aria-label="1 step"')
                expect(html).not.toMatch(/Comparing the options|Private trace|Legacy mixed block|Opaque bytes/)
            }
        } finally { chat.messages = []; chat.status = 'ready' }
    })
})
