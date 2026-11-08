// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'

vi.mock('@/stores/board.store', () => { throw new Error('Historical tool presentation imported the hosted board store') })

import { DesktopHistoricalCardView } from './DesktopHistoricalCardView'
import { DesktopHistoricalStepGroup } from './DesktopHistoricalStepGroup'
import type { DesktopHistoricalGenericItem } from './plan'
import { selectDesktopHistoricalCard } from './select'
import type { DesktopHistoricalToolSource } from './status'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = `sk-${'a'.repeat(24)}`
const PASSWORD = 'hunter2secret'

function part(extra: DesktopHistoricalToolSource): DesktopHistoricalToolSource {
    return { toolCallId: 'call-1', state: 'output-available', ...extra }
}

async function render(node: ReactNode) {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(node) })
    return {
        container,
        async unmount() { await act(async () => { root.unmount() }); container.remove() },
    }
}

test('opening a historical notification, MCP outcome, or brain change does not rerun a tool', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const onOpen = vi.fn()
    const notification = selectDesktopHistoricalCard(part({ type: 'tool-notify_user', toolCallId: 'note', input: { message: `Ready ${KEY}` }, output: 'Notification sent to the user.' }), { ownerId: 'agent-1', workspaceId: 'ws-1', runId: 'run-1' })
    const saved = selectDesktopHistoricalCard(part({ type: 'tool-mcp_register', toolCallId: 'mcp', input: { name: 'linear', url: 'https://user:pass@mcp.example.com/rpc' }, output: 'Saved linear.' }))
    const failed = selectDesktopHistoricalCard(part({ type: 'tool-mcp_register', toolCallId: 'mcp-failed', input: { name: 'linear' }, output: `Nothing was saved via remote: password=${PASSWORD}` }))
    const brain = selectDesktopHistoricalCard(part({ type: 'tool-brain_write', toolCallId: 'brain', output: JSON.stringify({ status: 'saved', slug: 'pricing', title: 'Pricing', mode: 'edit', undoRevisionId: 'rev-secret', hash: 'hash-secret' }) }))
    const deleted = selectDesktopHistoricalCard(part({ type: 'tool-brain_delete', toolCallId: 'gone', output: JSON.stringify({ status: 'deleted', slug: 'pricing', title: 'Pricing' }) }))
    if (!notification || !saved || !failed || !brain || !deleted) throw new Error('expected historical cards')
    const view = await render(<>
        <DesktopHistoricalCardView card={notification} />
        <DesktopHistoricalCardView card={saved} />
        <DesktopHistoricalCardView card={failed} />
        <DesktopHistoricalCardView card={brain} onOpenBrain={onOpen} />
        <DesktopHistoricalCardView card={deleted} onOpenBrain={onOpen} />
    </>)
    try {
        expect(view.container.textContent).toContain('Sent you a notification')
        expect(view.container.textContent).toContain('Read')
        expect(view.container.textContent).toContain('Ready [redacted]')
        expect(view.container.textContent).toContain('Linear added')
        expect(view.container.textContent).toContain('Custom MCP server · mcp.example.com')
        expect(view.container.textContent).toContain("Couldn't connect Linear")
        expect(view.container.textContent).toContain('Not added')
        expect(view.container.textContent).toContain('Brain updated: Pricing')
        expect(view.container.textContent).toContain('Saved. Every coworker reads it from its next run.')
        expect(view.container.textContent).toContain('Removed from the Brain: Pricing')
        expect(view.container.innerHTML).not.toContain(KEY)
        expect(view.container.innerHTML).not.toContain(PASSWORD)
        expect(view.container.innerHTML).not.toContain('user:pass')
        expect(view.container.innerHTML).not.toContain('rev-secret')
        expect(view.container.innerHTML).not.toContain('Undo')
        expect(view.container.innerHTML).not.toContain('Connect')
        expect(view.container.innerHTML).not.toContain('Sign in')
        expect(view.container.querySelector('[data-owner="agent-1"][data-workspace="ws-1"][data-run="run-1"][data-effect="none"]')).not.toBeNull()
        const open = [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Open')
        expect(open).toBeDefined()
        expect([...view.container.querySelectorAll('button')].filter(button => button.textContent === 'Open')).toHaveLength(1)
        await act(async () => { open!.click() })
        expect(onOpen).toHaveBeenCalledTimes(1)
        expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
        await view.unmount()
        vi.unstubAllGlobals()
    }
})

test('expanding a historical step group does not rerun a tool and names unknown instead of success', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const items: DesktopHistoricalGenericItem[] = [
        { key: 'unknown-1', toolName: 'exec', label: 'Shell', status: 'unknown', detail: null, identity: { ownerId: 'agent-1', workspaceId: 'ws-1', runId: 'run-1' } },
        { key: 'cancelled-1', toolName: 'exec', label: 'Shell', status: 'cancelled', detail: null, identity: { ownerId: 'agent-1', workspaceId: 'ws-1', runId: 'run-1' } },
        { key: 'failed-1', toolName: 'exec', label: 'Shell', status: 'failed', detail: 'Tool failed.', identity: { ownerId: 'agent-1', workspaceId: 'ws-1', runId: 'run-1' } },
    ]
    const view = await render(<DesktopHistoricalStepGroup items={items} />)
    try {
        const button = view.container.querySelector('button')!
        expect(button.getAttribute('aria-label')).toBe('3 steps, 1 failed, 1 cancelled, 1 unknown')
        expect(button.getAttribute('aria-expanded')).toBe('false')
        await act(async () => { button.click() })
        expect(button.getAttribute('aria-expanded')).toBe('true')
        expect(view.container.textContent).toContain('Unknown')
        expect(view.container.textContent).toContain('Cancelled')
        expect(view.container.textContent).toContain('Failed')
        expect(view.container.textContent).not.toContain('Succeeded')
        expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
        await view.unmount()
        vi.unstubAllGlobals()
    }
})
