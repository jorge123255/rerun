import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DesktopConversation } from './DesktopConversation'

const agent = { id: 'local-agent-1', name: 'Researcher', description: 'Finds answers', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

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
})
