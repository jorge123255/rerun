// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopSetupView } from '@rerun/contracts'

const local = vi.hoisted(() => ({
    read: vi.fn(), save: vi.fn(), start: vi.fn(), continueSetup: vi.fn(), skip: vi.fn(), dispose: vi.fn(),
}))
vi.mock('@/lib/desktop/setup-client', () => ({ createDesktopSetupClient: () => local }))

import { useDesktopSetup } from './useDesktopSetup'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function view(overrides: Partial<DesktopSetupView> = {}): DesktopSetupView {
    return {
        agentId: 'owner', revision: 'r1', required: true, prompt: 'Local prompt', completedAt: null,
        sessionId: null, pending: true, skipped: false, defaultPrompt: 'Safe default', ...overrides,
    }
}

const roots: { root: Root; host: HTMLElement }[] = []
afterEach(() => {
    for (const { root, host } of roots.splice(0)) {
        act(() => root.unmount())
        host.remove()
    }
    for (const fn of Object.values(local)) fn.mockReset()
})

function render(agentId = 'owner') {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    let current: ReturnType<typeof useDesktopSetup> | undefined
    function Harness() {
        current = useDesktopSetup(agentId)
        return <><span>{current.view?.revision ?? 'loading'}</span><span>{current.error}</span></>
    }
    act(() => root.render(<Harness />))
    return { host, current: () => current! }
}

it('loads persisted progress without issuing a Start mutation', async () => {
    local.read.mockResolvedValue(view({ sessionId: 'claimed' }))
    const rendered = render()
    await act(async () => {})
    expect(rendered.current().view?.sessionId).toBe('claimed')
    expect(local.start).not.toHaveBeenCalled()
})

it('keeps the current view and exposes a truthful error after a failed Start', async () => {
    local.read.mockResolvedValue(view())
    local.start.mockRejectedValueOnce(new Error('acknowledgment unknown')).mockResolvedValueOnce({ view: view({ revision: 'r2', sessionId: 'claimed' }), sessionId: 'claimed' })
    const rendered = render()
    await act(async () => {})
    await act(async () => { expect(await rendered.current().start()).toBeNull() })
    expect(rendered.current().view?.revision).toBe('r1')
    expect(rendered.current().error).toBe('acknowledgment unknown')
    await act(async () => { await rendered.current().start() })
    expect(local.start).toHaveBeenCalledTimes(2)
    expect(local.start.mock.calls[0][0]).toBe(local.start.mock.calls[1][0])
    expect(rendered.current().view?.sessionId).toBe('claimed')
})

it('refuses Continue before submission when no chat is claimed', async () => {
    local.read.mockResolvedValue(view())
    const rendered = render()
    await act(async () => {})
    await act(async () => { expect(await rendered.current().continueSetup()).toBeNull() })
    expect(local.continueSetup).not.toHaveBeenCalled()
    expect(rendered.current().error).toContain('No setup chat')
})

it('publishes an acknowledged Skip to the gate and skipped banner together', async () => {
    local.read.mockResolvedValue(view())
    local.skip.mockResolvedValue({ view: view({ revision: 'r2', pending: false, skipped: true }) })
    const gate = render()
    const banner = render()
    await act(async () => {})
    await act(async () => { await gate.current().skip() })
    expect(gate.current().view?.skipped).toBe(true)
    expect(banner.current().view?.skipped).toBe(true)
})

it('does not apply an old owner read after the owner changes', async () => {
    let finish!: (value: DesktopSetupView) => void
    local.read.mockImplementationOnce(() => new Promise<DesktopSetupView>(resolve => { finish = resolve }))
    local.read.mockResolvedValueOnce(view({ agentId: 'new-owner', revision: 'new-revision' }))
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    function Harness({ agentId }: { agentId: string }) {
        const current = useDesktopSetup(agentId)
        return <span>{current.view?.revision ?? 'loading'}</span>
    }
    act(() => root.render(<Harness agentId="owner" />))
    act(() => root.render(<Harness agentId="new-owner" />))
    await act(async () => {})
    expect(host.textContent).toBe('new-revision')
    await act(async () => { finish(view({ revision: 'old-revision' })) })
    expect(host.textContent).toBe('new-revision')
})
