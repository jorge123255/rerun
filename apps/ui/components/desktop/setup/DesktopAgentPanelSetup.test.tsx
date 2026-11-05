// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopSetupMutationResult, DesktopSetupView } from '@rerun/contracts'

const local = vi.hoisted(() => ({
    view: null as DesktopSetupView | null,
    loading: false,
    error: '',
    mutating: null as string | null,
    refresh: vi.fn(), save: vi.fn(), start: vi.fn(), continueSetup: vi.fn(), skip: vi.fn(), clearError: vi.fn(),
}))
vi.mock('./useDesktopSetup', () => ({ useDesktopSetup: () => local }))

import { DesktopAgentPanelSetup } from './DesktopAgentPanelSetup'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function view(overrides: Partial<DesktopSetupView> = {}): DesktopSetupView {
    return {
        agentId: 'owner', revision: 'r1', required: true, prompt: 'Original prompt', completedAt: null,
        sessionId: null, pending: false, skipped: false, defaultPrompt: 'Safe default', ...overrides,
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

function render(props: Partial<Parameters<typeof DesktopAgentPanelSetup>[0]> = {}) {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    act(() => root.render(<DesktopAgentPanelSetup agentId="owner" {...props} />))
    return host
}

function edit(host: HTMLElement, text: string) {
    const input = host.querySelector('textarea')!
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
    })
}

it('retains entered author text after failed or unknown save acknowledgment', async () => {
    local.view = view()
    local.save.mockResolvedValue(null)
    const onSaved = vi.fn()
    const host = render({ onSaved })
    await act(async () => {})
    edit(host, 'Unsaved local instructions')
    const save = [...host.querySelectorAll('button')].find(button => button.textContent === 'Save')!
    await act(async () => { save.click() })
    expect(host.querySelector('textarea')!.value).toBe('Unsaved local instructions')
    expect(onSaved).not.toHaveBeenCalled()
    expect(local.start).not.toHaveBeenCalled()
})

it('marks the acknowledged draft saved without creating or resetting a chat', async () => {
    local.view = view()
    const result: DesktopSetupMutationResult = { view: view({ revision: 'r2', prompt: 'Saved prompt', completedAt: 'now' }) }
    local.save.mockResolvedValue(result)
    const onSaved = vi.fn()
    const host = render({ onSaved })
    await act(async () => {})
    edit(host, 'Saved prompt')
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Save')!.click() })
    expect(onSaved).toHaveBeenCalledWith(result.view)
    expect(host.textContent).toContain('Saved')
    expect(local.start).not.toHaveBeenCalled()
    expect(local.continueSetup).not.toHaveBeenCalled()
})

it('reports unsaved edits and Cancel restores the last acknowledged draft', async () => {
    local.view = view()
    const onDirtyChange = vi.fn()
    const host = render({ onDirtyChange })
    await act(async () => {})
    edit(host, 'Discard me')
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.click() })
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Discard changes')!.click() })
    expect(host.querySelector('textarea')!.value).toBe('Original prompt')
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
})
