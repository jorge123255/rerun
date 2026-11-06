// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopSetupView } from '@rerun/contracts'

const local = vi.hoisted(() => ({
    view: null as DesktopSetupView | null,
    loading: false,
    error: '',
    mutating: null as string | null,
    refresh: vi.fn(), save: vi.fn(), start: vi.fn(), continueSetup: vi.fn(), skip: vi.fn(), clearError: vi.fn(),
}))
vi.mock('./useDesktopSetup', () => ({ useDesktopSetup: () => local }))

import { DesktopSetupGate, DesktopSetupSkippedBanner } from './DesktopSetupGate'

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
    local.view = null
    local.error = ''
    local.mutating = null
    for (const fn of [local.refresh, local.save, local.start, local.continueSetup, local.skip, local.clearError]) fn.mockReset()
})

function render(node: React.ReactNode) {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    act(() => root.render(node))
    return host
}

it('opens the server-claimed chat only after Start acknowledgment', async () => {
    local.view = view()
    local.start.mockResolvedValue({ view: view({ revision: 'r2', sessionId: 'claimed' }), sessionId: 'claimed' })
    const onOpenSetupChat = vi.fn()
    const host = render(<DesktopSetupGate agentId="owner" agentName="Ada" apps={[]} modelSlot={<span>Model picker</span>} onOpenSetupChat={onOpenSetupChat} />)
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Install Ada'))!.click() })
    expect(local.start).toHaveBeenCalledOnce()
    expect(local.continueSetup).not.toHaveBeenCalled()
    expect(onOpenSetupChat).toHaveBeenCalledWith({ agentId: 'owner', sessionId: 'claimed', action: 'start' })
})

it('a disabled imported coworker with rebind requirements stays idle until explicitly enabled and started', () => {
    local.view = view({ prompt: 'To provide again on a copy:\n- connection-rebind: connection\n- model-rebind: model' })
    const onOpenSetupChat = vi.fn()
    const host = render(<DesktopSetupGate agentId="owner" agentName="Ada" apps={[]} disabled onOpenSetupChat={onOpenSetupChat} />)
    const start = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Install Ada')!
    const skip = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Skip for now')!
    expect(host.textContent).toContain('Set up Ada')
    expect(host.textContent).not.toContain('Installing')
    expect(host.querySelector('[aria-busy="true"]')).toBeNull()
    expect(start().disabled).toBe(true)
    expect(skip().disabled).toBe(true)
    act(() => { start().click(); skip().click() })
    expect(local.start).not.toHaveBeenCalled()
    expect(local.skip).not.toHaveBeenCalled()
    expect(onOpenSetupChat).not.toHaveBeenCalled()

    act(() => roots.at(-1)!.root.render(<DesktopSetupGate agentId="owner" agentName="Ada" apps={[]} onOpenSetupChat={onOpenSetupChat} />))
    expect(start().disabled).toBe(false)
    expect(skip().disabled).toBe(false)
    expect(host.textContent).not.toContain('Installing')
    expect(local.start).not.toHaveBeenCalled()
    expect(onOpenSetupChat).not.toHaveBeenCalled()
})

it('an actual shared setup mutation owns the spinner and releases it after acknowledgement', () => {
    local.view = view()
    local.mutating = 'start'
    const props = { agentId: 'owner', agentName: 'Ada', apps: [], onOpenSetupChat: vi.fn() }
    const host = render(<DesktopSetupGate {...props} />)
    expect(host.textContent).toContain('Installing')
    expect(host.querySelector('button[aria-busy="true"]')).not.toBeNull()
    expect([...host.querySelectorAll('button')].find(button => button.textContent === 'Skip for now')!.disabled).toBe(true)
    local.mutating = null
    act(() => roots.at(-1)!.root.render(<DesktopSetupGate {...props} />))
    expect(host.textContent).toContain('Install Ada')
    expect(host.textContent).not.toContain('Installing')
    expect(host.querySelector('[aria-busy="true"]')).toBeNull()
    expect(local.start).not.toHaveBeenCalled()
})

it('keeps the claimed chat closed when Start acknowledgment fails', async () => {
    local.view = view()
    local.start.mockResolvedValue(null)
    local.error = 'acknowledgment unknown'
    const onOpenSetupChat = vi.fn()
    const host = render(<DesktopSetupGate agentId="owner" agentName="Ada" apps={[]} onOpenSetupChat={onOpenSetupChat} />)
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Install Ada'))!.click() })
    expect(onOpenSetupChat).not.toHaveBeenCalled()
    expect(host.textContent).toContain('acknowledgment unknown')
})

it('does not claim a chat before the injected model picker is ready', async () => {
    local.view = view()
    const onStartBlocked = vi.fn()
    const onOpenSetupChat = vi.fn()
    const host = render(<DesktopSetupGate agentId="owner" agentName="Ada" apps={[]} canStart={false} onStartBlocked={onStartBlocked} onOpenSetupChat={onOpenSetupChat} />)
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Install Ada'))!.click() })
    expect(onStartBlocked).toHaveBeenCalledOnce()
    expect(local.start).not.toHaveBeenCalled()
    expect(onOpenSetupChat).not.toHaveBeenCalled()
})

it('always continues an existing claim instead of repeating Start', async () => {
    local.view = view({ sessionId: 'claimed' })
    local.continueSetup.mockResolvedValue({ view: view({ sessionId: 'claimed' }), sessionId: 'claimed' })
    const onOpenSetupChat = vi.fn()
    const host = render(<DesktopSetupGate agentId="owner" agentName="Ada" apps={[]} onOpenSetupChat={onOpenSetupChat} />)
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Continue setup'))!.click() })
    expect(local.continueSetup).toHaveBeenCalledOnce()
    expect(local.start).not.toHaveBeenCalled()
    expect(onOpenSetupChat).toHaveBeenCalledWith({ agentId: 'owner', sessionId: 'claimed', action: 'continue' })
})

it('persists Skip without navigation or activation callbacks', async () => {
    local.view = view()
    local.skip.mockResolvedValue({ view: view({ pending: false, skipped: true }) })
    const onOpenSetupChat = vi.fn()
    const host = render(<DesktopSetupGate agentId="owner" agentName="Ada" apps={[]} onOpenSetupChat={onOpenSetupChat} />)
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Skip for now')!.click() })
    expect(local.skip).toHaveBeenCalledOnce()
    expect(onOpenSetupChat).not.toHaveBeenCalled()
    expect(local.start).not.toHaveBeenCalled()
})

it('resumes a skipped existing claim through Continue', async () => {
    local.view = view({ sessionId: 'claimed', pending: false, skipped: true })
    local.continueSetup.mockResolvedValue({ view: view({ sessionId: 'claimed', skipped: false }), sessionId: 'claimed' })
    const onOpenSetupChat = vi.fn()
    const host = render(<DesktopSetupSkippedBanner agentId="owner" onOpenSetupChat={onOpenSetupChat} />)
    expect(host.textContent).toContain('This coworker has not been set up yet')
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Set it up'))!.click() })
    expect(local.continueSetup).toHaveBeenCalledOnce()
    expect(onOpenSetupChat).toHaveBeenCalledWith({ agentId: 'owner', sessionId: 'claimed', action: 'continue' })
})
