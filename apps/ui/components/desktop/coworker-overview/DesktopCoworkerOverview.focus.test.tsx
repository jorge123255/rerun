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
        expect(back.isConnected).toBe(false)
        expect(document.activeElement).toBe(files)
    } finally {
        await act(async () => root.unmount())
        host.remove()
    }
})


it('moves keyboard focus between settings tabs and activates only on Enter', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const key = async (target: Element, value: string) => {
        await act(async () => {
            target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
            await new Promise(resolve => setTimeout(resolve, 0))
        })
    }
    try {
        await act(async () => root.render(<DesktopCoworkerOverview
            identity={{ ownerId: 'qa-owner', workspaceId: 1, agentId: 'coworker' }}
            agent={{ id: 'coworker', name: 'QA Coworker', spaceId: 'box' }}
            boxes={[{ id: 'box', name: 'QA Box' }]}
            onClose={vi.fn()}
            onRenamed={vi.fn()}
            renderTab={tab => <p>{tab === 'settings' ? 'Saved instructions' : 'Tool permissions'}</p>}
        />))
        await act(async () => host.querySelector<HTMLButtonElement>('[data-overview-focus="settings"] button')!.click())
        const general = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === 'General')!
        const capabilities = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Capabilities')!
        expect(document.activeElement).toBe(general)
        await key(general, 'ArrowRight')
        expect(document.activeElement).toBe(capabilities)
        expect(host.textContent).toContain('Saved instructions')
        expect(host.textContent).not.toContain('Tool permissions')
        expect(general.getAttribute('aria-selected')).toBe('true')
        expect(capabilities.getAttribute('aria-selected')).toBe('false')
        await key(capabilities, 'Enter')
        expect(capabilities.getAttribute('aria-selected')).toBe('true')
        expect(host.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toBe('Tool permissions')
        expect(host.querySelector('[role="tabpanel"]:not([hidden])')?.getAttribute('aria-labelledby')).toBe(capabilities.id)
        await key(capabilities, 'Home')
        expect(document.activeElement).toBe(general)
        expect(capabilities.getAttribute('aria-selected')).toBe('true')
    } finally {
        await act(async () => root.unmount())
        host.remove()
    }
})
