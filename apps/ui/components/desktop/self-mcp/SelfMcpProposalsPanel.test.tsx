// @vitest-environment happy-dom
import { act, StrictMode, type ReactNode } from 'react'
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
async function waitFor(check: () => void, rounds = 10) {
    let lastError: unknown
    for (let i = 0; i < rounds; i++) {
        try {
            await act(async () => {})
            check()
            return
        } catch (error) {
            lastError = error
        }
    }
    throw lastError
}
const findByRole = async (role: string, options?: { name: string }) => {
    await waitFor(() => expect(screen.getByRole(role, options)).toBeTruthy())
    return screen.getByRole(role, options)
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { SelfMcpProposal, SelfMcpReviewSnapshot } from '@rerun/contracts'

// The review editor/panel never talks to the network directly; only sonner toasts need stubbing.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/components/ui/panel-steps', () => ({ PanelSteps: ({ children }: { children: ReactNode }) => <>{children}</> }))
import { SelfMcpProposalsPanel } from './SelfMcpProposalsPanel'

const proposal: SelfMcpProposal = {
    id: 'prop-1',
    revision: 1,
    agentId: 'agent-1',
    launchEpoch: 'epoch-1',
    identity: { engineAgentId: 'engine-1', sessionId: 's', runId: 'r', toolCallId: 'call-1' },
    fingerprint: 'a'.repeat(64),
    input: { name: 'linear', transport: 'http', command: undefined, args: [], url: 'https://mcp.linear.app', env: {}, headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' } },
    transport: 'http',
    configRevision: 3,
    status: 'pending',
    createdAt: '2026-11-05T00:00:00.000Z',
}

const snapshot: SelfMcpReviewSnapshot = {
    proposal,
    configRevision: 3,
    connectivity: 'unverified',
    requirements: [],
    conflict: { existing: false, managed: false },
    alreadyConfigured: false,
}

type PanelFetchOptions = {
    list?: unknown
    review?: unknown
    decide?: unknown
    dismiss?: unknown
    decideDelay?: Promise<Response>
    decideResponses?: Response[]
}

function mockPanelFetch(options: PanelFetchOptions = {}) {
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        requests.push(body)
        if (body.action === 'list') return Promise.resolve(Response.json(options.list ?? { proposals: [proposal] }))
        if (body.action === 'review') return Promise.resolve(Response.json(options.review ?? snapshot))
        if (body.action === 'decide') return options.decideDelay ?? Promise.resolve(options.decideResponses?.shift() ?? Response.json(options.decide ?? { outcome: 'applied', proposalId: 'prop-1', proposalRevision: 2, message: 'The server was saved and verified.', requirements: [] }))
        if (body.action === 'dismiss') return Promise.resolve(Response.json(options.dismiss ?? { outcome: 'cancelled', proposalId: 'prop-1', proposalRevision: 2, message: 'The proposal was cancelled without saving.', requirements: [] }))
        return Promise.resolve(Response.json({ error: 'unknown action' }, { status: 400 }))
    }))
    return requests
}

afterEach(() => {
    for (const { root, host } of roots.splice(0)) {
        act(() => root.unmount())
        host.remove()
    }
    vi.unstubAllGlobals()
    vi.clearAllMocks()
})

describe('SelfMcpProposalsPanel', () => {
    it('lists proposals and opens the read-only review editor', async () => {
        mockPanelFetch()
        render(<SelfMcpProposalsPanel agentId="agent-1" />)
        fireEvent.click(await findByRole('button', { name: 'linear' }))
        await findByRole('button', { name: 'Approve and save' })
        expect(document.body.textContent).toContain('Review MCP proposal · linear')
        const nameField = [...document.querySelectorAll('input')].find(input => (input as HTMLInputElement).value === 'linear')
        expect(nameField).toBeTruthy()
        expect((nameField as HTMLInputElement).disabled).toBe(true)
    })

    it('approves with a decide envelope carrying the CAS revisions and returns to the list', async () => {
        const requests = mockPanelFetch()
        render(<SelfMcpProposalsPanel agentId="agent-1" />)
        fireEvent.click(await findByRole('button', { name: 'linear' }))
        await findByRole('button', { name: 'Approve and save' })
        fireEvent.click(screen.getByRole('button', { name: 'Approve and save' }))
        await waitFor(() => expect(requests.some(request => request.action === 'decide')).toBe(true))
        const decideBody = requests.find(request => request.action === 'decide') as { decision: Record<string, unknown> }
        expect(decideBody.decision).toMatchObject({
            proposalId: 'prop-1',
            expectedProposalRevision: 1,
            expectedConfigRevision: 3,
            outcome: { kind: 'approved' },
        })
        expect(String(decideBody.decision.decisionId).length).toBeGreaterThan(0)
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve and save' })).toBeNull())
    })

    it('rejects with a rejected outcome', async () => {
        const requests = mockPanelFetch()
        render(<SelfMcpProposalsPanel agentId="agent-1" />)
        fireEvent.click(await findByRole('button', { name: 'linear' }))
        await findByRole('button', { name: 'Reject' })
        fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
        await waitFor(() => expect(requests.some(request => request.action === 'decide')).toBe(true))
        const decideBody = requests.find(request => request.action === 'decide') as { decision: { outcome: { kind: string } } }
        expect(decideBody.decision.outcome.kind).toBe('rejected')
    })

    it('cancels a proposal via dismiss', async () => {
        const requests = mockPanelFetch()
        render(<SelfMcpProposalsPanel agentId="agent-1" />)
        fireEvent.click(await findByRole('button', { name: 'linear' }))
        await findByRole('button', { name: 'Cancel proposal' })
        fireEvent.click(screen.getByRole('button', { name: 'Cancel proposal' }))
        await waitFor(() => expect(requests.some(request => request.action === 'dismiss')).toBe(true))
        const dismissBody = requests.find(request => request.action === 'dismiss') as Record<string, unknown>
        expect(dismissBody).toMatchObject({ proposalId: 'prop-1', expectedProposalRevision: 1 })
    })

    it('disables review actions while a decision is in flight', async () => {
        let finish!: (response: Response) => void
        mockPanelFetch({ decideDelay: new Promise<Response>(resolve => { finish = resolve }) })
        render(<SelfMcpProposalsPanel agentId="agent-1" />)
        fireEvent.click(await findByRole('button', { name: 'linear' }))
        await findByRole('button', { name: 'Approve and save' })
        fireEvent.click(screen.getByRole('button', { name: 'Approve and save' }))
        await waitFor(() => expect((screen.getByRole('button', { name: 'Approve and save' }) as HTMLButtonElement).disabled).toBe(true))
        expect((screen.getByRole('button', { name: 'Cancel proposal' }) as HTMLButtonElement).disabled).toBe(true)
        await act(async () => finish(Response.json({ outcome: 'applied', proposalId: 'prop-1', proposalRevision: 2, message: 'The server was saved and verified.', requirements: [] })))
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve and save' })).toBeNull())
    })

    it('shows a visible requirement when approving would need an unavailable capability', async () => {
        mockPanelFetch({
            review: { ...snapshot, requirements: ['Local program execution requires the separate Local MCP programs permission.'] },
            decide: { outcome: 'failed', proposalId: 'prop-1', proposalRevision: 2, message: 'Local program execution requires the separate Local MCP programs permission.', requirements: ['Local program execution requires the separate Local MCP programs permission.'] },
        })
        render(<SelfMcpProposalsPanel agentId="agent-1" />)
        fireEvent.click(await findByRole('button', { name: 'linear' }))
        await waitFor(() => expect(document.body.textContent).toContain('Local program execution requires the separate Local MCP programs permission.'))
    })

    it('retries an unknown acknowledgement with the same reviewed decision identity', async () => {
        const requests = mockPanelFetch({ decideResponses: [Response.json({ error: 'Acknowledgement lost' }, { status: 503 })] })
        render(<SelfMcpProposalsPanel agentId="agent-1" />)
        fireEvent.click(await findByRole('button', { name: 'linear' }))
        fireEvent.click(await findByRole('button', { name: 'Approve and save' }))
        await waitFor(() => expect(document.body.textContent).toContain('The result could not be confirmed'))
        fireEvent.click(screen.getByRole('button', { name: 'Approve and save' }))
        await waitFor(() => expect(requests.filter(request => request.action === 'decide')).toHaveLength(2))
        const attempts = requests.filter(request => request.action === 'decide')
        expect(attempts[1].decision).toEqual(attempts[0].decision)
    })

    it('does not toast a failed save as success', async () => {
        mockPanelFetch({ decide: { outcome: 'failed', proposalId: 'prop-1', proposalRevision: 3, message: 'Nothing was saved.', requirements: [] } })
        render(<SelfMcpProposalsPanel agentId="agent-1" />)
        fireEvent.click(await findByRole('button', { name: 'linear' }))
        fireEvent.click(await findByRole('button', { name: 'Approve and save' }))
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nothing was saved.'))
        expect(toast.success).not.toHaveBeenCalled()
    })

    it('suppresses the previous coworker late completion after switching owners', async () => {
        let finish!: (response: Response) => void
        mockPanelFetch({ decideDelay: new Promise<Response>(resolve => { finish = resolve }) })
        const { rerender } = render(<SelfMcpProposalsPanel agentId="agent-1" />)
        fireEvent.click(await findByRole('button', { name: 'linear' }))
        fireEvent.click(await findByRole('button', { name: 'Approve and save' }))
        rerender(<SelfMcpProposalsPanel agentId="agent-2" />)
        await act(async () => finish(Response.json({ outcome: 'applied', proposalId: 'prop-1', proposalRevision: 3, message: 'Old owner saved.', requirements: [] })))
        expect(toast.success).not.toHaveBeenCalled()
        expect(toast.error).not.toHaveBeenCalled()
        const calls = vi.mocked(fetch).mock.calls
        expect(calls.some(([url, init]) => String(url).includes('/agent-2/') && JSON.parse(String(init?.body)).action === 'list')).toBe(true)
    })

    it('opens reviews after a strict-mode setup and cleanup cycle', async () => {
        mockPanelFetch()
        render(<StrictMode><SelfMcpProposalsPanel agentId="agent-1" /></StrictMode>)
        fireEvent.click(await findByRole('button', { name: 'linear' }))
        await findByRole('button', { name: 'Approve and save' })
    })
})
