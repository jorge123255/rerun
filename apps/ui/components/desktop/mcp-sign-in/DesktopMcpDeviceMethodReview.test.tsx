// @vitest-environment happy-dom
import { act, type ButtonHTMLAttributes } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { McpDeviceMethodReview, McpDeviceReviewDecision } from '@/lib/desktop/mcp-device-review'
import { DesktopMcpDeviceMethodReview } from './DesktopMcpDeviceMethodReview'
vi.mock('@/components/ui/button', () => ({ Button: ({ size: _size, variant: _variant, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => <button {...props} /> }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const review = (): McpDeviceMethodReview => ({ reviewId: crypto.randomUUID(), revision: crypto.randomUUID(), workspaceId: 'workspace', owner: 'coworker', localSessionId: 'local-chat', serverName: 'docs', registrationRevision: 'r1', state: 'pending', expiresAt: Date.now() + 300_000,
    method: { kind: 'device-code-link-v1', resource: 'https://docs.example/mcp', issuer: 'https://issuer.example/', clientId: 'public-client', scope: 'notes.read notes.write', deviceEndpoint: 'https://issuer.example/device', tokenEndpoint: 'https://issuer.example/token', verificationUri: 'https://issuer.example/activate' } })

it('shows the exact method, never auto-approves and sends only identity plus explicit decision', async () => {
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host), view = review()
    const onDecide = vi.fn(async (input: McpDeviceReviewDecision) => ({ ...view, state: 'approved' as const, receipt: { decisionId: input.decisionId, outcome: 'approved' as const, recordedAt: Date.now() } }))
    try {
        await act(async () => root.render(<DesktopMcpDeviceMethodReview review={view} active onDecide={onDecide} />))
        expect(onDecide).not.toHaveBeenCalled()
        for (const field of [view.method.issuer, view.method.clientId, view.method.scope!, view.method.resource, view.registrationRevision]) expect(host.textContent).toContain(field)
        expect(host.querySelector('input, textarea, a')).toBeNull()
        const button = [...host.querySelectorAll('button')].find(item => item.textContent === 'Approve device method')!
        await act(async () => { button.click(); button.click() })
        expect(onDecide).toHaveBeenCalledTimes(1)
        expect(onDecide.mock.calls[0]![0]).toEqual({ reviewId: view.reviewId, revision: view.revision, decisionId: expect.any(String), operation: 'approve-device-method' })
        expect(host.textContent).toContain('connection is not yet verified')
        expect(host.textContent).toContain('Saved decision: approved')
    } finally { await act(async () => root.unmount()); host.remove() }
})

it('keeps the same decision ID after a lost acknowledgement and ignores a reply after the rendered owner changes', async () => {
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host), view = review(), foreign = { ...review(), owner: 'other-coworker' }
    let finish!: (view: McpDeviceMethodReview) => void
    const response = new Promise<McpDeviceMethodReview>(resolve => { finish = resolve })
    const onDecide = vi.fn<(input: McpDeviceReviewDecision, signal: AbortSignal) => Promise<McpDeviceMethodReview>>()
        .mockRejectedValueOnce(new Error('FIXTURE_PRIVATE_ERROR')).mockImplementationOnce(() => response)
    const click = () => [...host.querySelectorAll('button')].find(item => item.textContent === 'Approve device method')!.click()
    try {
        await act(async () => root.render(<DesktopMcpDeviceMethodReview review={view} active onDecide={onDecide} />))
        await act(async () => click())
        expect(host.textContent).not.toContain('FIXTURE_')
        await act(async () => root.render(<DesktopMcpDeviceMethodReview review={{ ...view }} active onDecide={onDecide} />))
        await act(async () => click())
        expect(onDecide.mock.calls[1]![0].decisionId).toBe(onDecide.mock.calls[0]![0].decisionId)
        await act(async () => root.render(<DesktopMcpDeviceMethodReview review={foreign} active onDecide={onDecide} />))
        await act(async () => finish({ ...view, state: 'approved' }))
        expect(host.querySelector('[role="status"]')?.textContent).toBe('pending')
    } finally { await act(async () => root.unmount()); host.remove() }
})

it('disables approval for expired or inactive reviews', async () => {
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host), view = review(), onDecide = vi.fn()
    try {
        await act(async () => root.render(<DesktopMcpDeviceMethodReview review={{ ...view, expiresAt: Date.now() - 1 }} active onDecide={onDecide} />))
        expect([...host.querySelectorAll('button')].find(item => item.textContent === 'Approve device method')?.disabled).toBe(true)
        await act(async () => root.render(<DesktopMcpDeviceMethodReview review={view} active={false} onDecide={onDecide} />))
        expect([...host.querySelectorAll('button')].every(item => item.disabled)).toBe(true)
        expect(onDecide).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()); host.remove() }
})
