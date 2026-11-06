// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopToolInstallSnapshot } from '@rerun/contracts'

const state = vi.hoisted(() => ({ snapshot: null as DesktopToolInstallSnapshot | null, loading: false, error: '', action: null as string | null, refresh: vi.fn(), decide: vi.fn(), inspect: vi.fn() }))
vi.mock('./useDesktopToolInstall', () => ({ useDesktopToolInstall: () => state }))

import { DesktopToolInstallCard } from './DesktopToolInstallCard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: { root: Root; host: HTMLElement }[] = []
afterEach(() => {
    for (const { root, host } of roots.splice(0)) {
        act(() => root.unmount())
        host.remove()
    }
    state.snapshot = null
    state.error = ''
    state.action = null
    for (const fn of [state.refresh, state.decide, state.inspect]) fn.mockReset()
})

const snapshot: DesktopToolInstallSnapshot = {
    operationId: 'a'.repeat(64), agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'tool', proposalRevision: '1', revision: '1', status: 'pending-approval',
    packages: [{ package: 'left-pad@1.2.3', status: 'pending' }], guestId: 'b'.repeat(64), availability: 'isolated-guest-only', createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:00:00.000Z',
}

function render(next: DesktopToolInstallSnapshot) {
    state.snapshot = next
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    act(() => root.render(<DesktopToolInstallCard sessionId="session" operationId={next.operationId} />))
    return host
}

it('shows the original approval design and exact isolated package scope', async () => {
    const host = render(snapshot)
    expect(host.textContent).toContain('Approval required')
    expect(host.textContent).toContain('Install npm packages: left-pad@1.2.3')
    expect(host.textContent).toContain('Package scripts are code execution')
    const approve = [...host.querySelectorAll('button')].find(button => button.textContent === 'Approve')!
    await act(async () => { approve.click() })
    expect(state.decide).toHaveBeenCalledWith('approved', undefined)
})

it('offers explicit recovery inspection without claiming reinstall', async () => {
    const host = render({ ...snapshot, status: 'uncertain' })
    expect(host.textContent).toContain('do not reinstall automatically')
    const inspect = [...host.querySelectorAll('button')].find(button => button.textContent === 'Inspect in isolated computer')!
    await act(async () => { inspect.click() })
    expect(state.inspect).toHaveBeenCalledOnce()
})

it('renders per-package evidence and the guest-only availability boundary', () => {
    const host = render({ ...snapshot, status: 'installed', packages: [{ package: 'left-pad@1.2.3', status: 'installed', manifestSha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64) }] })
    expect(host.textContent).toContain('Installed left-pad@1.2.3')
    expect(host.textContent).toContain(`manifest ${'a'.repeat(64)}`)
    expect(host.textContent).toContain(`lock ${'b'.repeat(64)}`)
    expect(host.textContent).toContain('Available in this coworker’s isolated computer.')
})
