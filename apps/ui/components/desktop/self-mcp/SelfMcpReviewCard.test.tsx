// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: { root: Root; host: HTMLElement }[] = []
function render(node: ReactNode) {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    act(() => root.render(node))
    return { rerender: (next: ReactNode) => act(() => root.render(next)) }
}
const screen = {
    getByRole: (role: string, options?: { name: string }) => {
        const e = [...document.querySelectorAll(role === 'button' ? 'button' : `[role="${role}"]`)].find(el => !options || el.getAttribute('aria-label') === options.name || el.textContent?.trim() === options.name)
        if (!e) throw new Error('Missing ' + role)
        return e
    },
    queryByRole: (role: string, options?: { name: string }) => [...document.querySelectorAll(role === 'button' ? 'button' : `[role="${role}"]`)].find(el => !options || el.getAttribute('aria-label') === options.name || el.textContent?.trim() === options.name) ?? null,
}
const fireEvent = { click: (e: Element) => act(() => { (e as HTMLElement).click() }) }
async function waitFor(check: () => void, rounds = 8) {
    for (let i = 0; i < rounds; i++) await act(async () => {})
    check()
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SelfMcpProposal } from '@rerun/contracts'
import { SelfMcpReviewCard } from './SelfMcpReviewCard'

const proposal: SelfMcpProposal = {
    id: 'prop-1',
    revision: 1,
    agentId: 'agent-1',
    launchEpoch: 'epoch-1',
    identity: { engineAgentId: 'engine-1', sessionId: 's', runId: 'r', toolCallId: 'call-1' },
    fingerprint: 'a'.repeat(64),
    input: { name: 'linear', transport: 'http', command: undefined, args: [], url: 'https://mcp.linear.app', env: {}, headers: {} },
    transport: 'http',
    configRevision: 3,
    status: 'pending',
    createdAt: '2026-11-05T00:00:00.000Z',
}

afterEach(() => {
    for (const { root, host } of roots.splice(0)) {
        act(() => root.unmount())
        host.remove()
    }
    vi.unstubAllGlobals()
})

describe('SelfMcpReviewCard', () => {
    it('renders name, transport destination and the pending status badge', () => {
        render(<SelfMcpReviewCard proposal={proposal} />)
        expect(document.body.textContent).toContain('linear')
        expect(document.body.textContent).toContain('http · https://mcp.linear.app')
        expect(document.body.textContent).toContain('Waiting for review')
    })

    it('shows the command line for a stdio proposal', () => {
        render(<SelfMcpReviewCard proposal={{ ...proposal, transport: 'stdio', input: { ...proposal.input, name: 'local-tool', transport: 'stdio', command: 'npx', args: ['-y', '@server/files'], url: undefined } }} />)
        expect(document.body.textContent).toContain('stdio · npx -y @server/files')
    })

    it('opens when the name is clicked', () => {
        const onOpen = vi.fn()
        render(<SelfMcpReviewCard proposal={proposal} onOpen={onOpen} />)
        fireEvent.click(screen.getByRole('button', { name: 'linear' }))
        expect(onOpen).toHaveBeenCalledTimes(1)
    })

    it('labels a settled proposal', () => {
        render(<SelfMcpReviewCard proposal={{ ...proposal, status: 'applied' }} />)
        expect(document.body.textContent).toContain('Saved')
    })
})
