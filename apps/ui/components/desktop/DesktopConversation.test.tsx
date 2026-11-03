import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
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
        />)
        expect(html).toContain('flex-wrap')
        expect(html).toContain('Conversation history')
        expect(html).toContain('desktop-message')
        expect(html).toContain('sm:w-auto')
    })

    it('renders only marked Codex summaries as upstream running and settled reasoning steps', () => {
        const render = () => renderToString(<DesktopConversation agent={agent} sessionId="s" sessions={[]} onChatSession={vi.fn()} onSelectSession={vi.fn()} />)
        chat.messages = [{ id: 'answer', role: 'assistant', parts: [
            { type: 'reasoning', text: 'Private trace' },
            { type: 'reasoning', text: 'Legacy mixed block', providerMetadata: { 'codex-app-server': { isSummary: true } } },
            { type: 'reasoning', text: 'Comparing the options.', providerMetadata: { 'codex-app-server': { isPublicSummary: true, encrypted: 'Opaque bytes' } } },
        ] }]
        try {
            chat.status = 'streaming'
            const live = render()
            expect(live).toContain('Thinking...')
            expect(live).toContain('Comparing the options.')
            chat.status = 'ready'
            const saved = render()
            expect(saved).toContain('Thought')
            expect(saved).toContain('Comparing the options.')
            for (const html of [live, saved]) {
                expect(html).not.toMatch(/Private trace|Legacy mixed block|Opaque bytes/)
            }
        } finally { chat.messages = []; chat.status = 'ready' }
    })
})
