// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DesktopCoworkerOverview } from './DesktopCoworkerOverview'

vi.mock('@/components/agent/sheet/AgentCard', () => ({ CardDestinationGhost: () => null }))
vi.mock('@/components/agent/sheet/AgentViewExpander', () => ({
    AgentViewExpander: ({ children }: { children: ReactNode }) => children,
    measureCardOrigin: (tab: string) => ({ tab, shape: 'row' }),
}))
vi.mock('motion/react', async importOriginal => ({
    ...await importOriginal<typeof import('motion/react')>(),
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@rerun/ui/iso-grid', () => ({ AgentBuddy: () => null }))
vi.mock('@/components/desktop/DesktopCoworkerNotificationBell', () => ({ DesktopCoworkerNotificationControl: () => null }))

it.each(['Back', 'Escape'])('restores the originating Overview control after %s', async action => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
        await act(async () => root.render(<DesktopCoworkerOverview
            identity={{ ownerId: 'qa-owner', workspaceId: 1, agentId: 'coworker' }}
            agent={{ id: 'coworker', name: 'QA Coworker', spaceId: 'box' }}
            boxes={[{ id: 'box', name: 'QA Box' }]}
            onClose={vi.fn()}
            onRenamed={vi.fn()}
        />))
        const files = host.querySelector<HTMLElement>('[data-overview-focus="files"]')!
        await act(async () => files.focus())
        expect(document.activeElement).toBe(files)
        await act(async () => files.querySelector('button')!.click())
        const back = [...host.querySelectorAll('button')].find(button => button.textContent === 'QA Coworker' && !button.closest('[aria-hidden="true"]'))!
        expect(back).toBeDefined()
        back.focus()
        expect(document.activeElement).toBe(back)
        await act(async () => {
            if (action === 'Back') back.click()
            else back.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
        expect(host.querySelector('[data-overview-tabs]')).toBeNull()
        expect(document.activeElement).toBe(files)
    } finally {
        await act(async () => root.unmount())
        host.remove()
    }
})
