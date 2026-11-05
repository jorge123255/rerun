// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
const conversations = vi.hoisted(() => new Map<string, { onSelectSession: (id: string, title?: string) => void }>())
vi.mock('./DesktopConversation', () => ({ DesktopConversation: (props: { sessionId: string; onSelectSession: (id: string, title?: string) => void; tabStrip: ReactNode }) => { conversations.set(props.sessionId, props); return <div>{props.tabStrip}<textarea aria-label={`Draft ${props.sessionId}`} defaultValue="Keep original draft" /></div> } }))
import { DesktopChatTabs } from './DesktopChatTabs'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('opens an adopted routine with its known title and refreshes history without remounting the original draft', async () => {
    const agent = { id: 'routine-tabs-owner', name: 'Reviewer', description: '', createdAt: '', updatedAt: '' }
    let revision = 0
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tabs: { revision: ++revision } })))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container), refreshSessions = vi.fn(async () => {})
    try {
        await act(async () => { root.render(<DesktopChatTabs agent={agent} sessions={[{ id: 'original', agentId: agent.id, title: 'Original chat', createdAt: '', updatedAt: '' }]}
            initialLayout={{ revision: 0, activeIndex: 0, tabs: [{ uid: 'original-tab', id: 'original', title: 'Original chat' }] }} requested={null} selected
            refreshSessions={refreshSessions} reload={() => {}} onClosePanel={() => {}} onOpenModelSettings={() => {}} />) })
        const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Draft original"]')!
        await act(async () => { conversations.get('original')!.onSelectSession('scheduled-local', 'Routine result') })
        expect(container.textContent).toContain('Routine result')
        expect(refreshSessions).toHaveBeenCalledOnce()
        expect(container.querySelector('[aria-label="Draft original"]')).toBe(field)
        expect(field.value).toBe('Keep original draft')
    } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); conversations.clear() }
})
