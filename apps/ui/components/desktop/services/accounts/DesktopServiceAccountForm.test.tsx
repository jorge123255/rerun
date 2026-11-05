// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import type { DesktopServiceAccountView } from '../../../../../../packages/contracts/src/desktop-service-accounts'
import type { ServiceAccountMethod } from '@/lib/desktop/service-accounts-client'
import { DesktopServiceAccountForm } from './DesktopServiceAccountForm'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Array<{ root: Root; host: HTMLElement }> = []
afterEach(() => { for (const { root, host } of roots.splice(0)) { act(() => root.unmount()); host.remove() } })

const method: ServiceAccountMethod = {
    id: 'token',
    label: 'API key',
    kind: 'key',
    recommended: true,
    inputs: [
        { key: 'WORKSPACE', label: 'Workspace', required: true },
        { key: 'TOKEN', label: 'Token', type: 'password', secret: true, required: true },
    ],
    requiresSecrets: true,
    availability: { id: 'token', supported: true },
}

function saved(identity: string): DesktopServiceAccountView {
    return {
        key: 'fixture',
        slug: 'fixture',
        label: 'Fixture',
        name: 'Fixture',
        icon: null,
        category: 'dev',
        status: 'needs_config',
        toolNames: [],
        authMethodId: 'token',
        installedAt: '2026-01-01T00:00:00.000Z',
        revision: '00000000-0000-4000-8000-000000000010',
        health: { state: 'unchecked' },
        installationId: identity,
        shape: 'headers',
        headerPlan: [{ name: 'X-Api-Key', source: 'input', inputKeys: ['TOKEN'], secret: true }],
        configured: true,
        configuredInputs: { TOKEN: true },
        publicInputs: { WORKSPACE: 'acme' },
    }
}

function render(identity: string, props?: { saved?: DesktopServiceAccountView | null; onSubmit?: (methodId: string, values: Record<string, string>) => Promise<void>; onCancel?: () => void; methods?: ServiceAccountMethod[] }) {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    const onSubmit = (props?.onSubmit ?? vi.fn(async () => {})) as Mock
    const onCancel = props?.onCancel ?? vi.fn()
    function draw(next = identity) {
        act(() => root.render(<DesktopServiceAccountForm identity={next} methods={props?.methods ?? [method]} saved={props?.saved === undefined ? null : props.saved} submitLabel="Install" onSubmit={onSubmit} onCancel={onCancel} />))
    }
    draw()
    return { host, draw, onSubmit, onCancel }
}

function type(input: HTMLInputElement, value: string) {
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
    })
}

it('keeps separate drafts and does not echo a saved credential', () => {
    const identity = '00000000-0000-4000-8000-000000000021'
    const other = '00000000-0000-4000-8000-000000000022'
    const view = render(identity, { saved: saved(identity) })
    const inputs = () => [...view.host.querySelectorAll('input')]
    expect(inputs()[0].value).toBe('acme')
    expect(inputs()[1].value).toBe('')
    expect(view.host.textContent).toContain('Credential configured. Saved credentials are never returned to this form.')
    expect(view.host.textContent).not.toContain('fixture-header-value')
    type(inputs()[0], 'keep-me')
    view.draw(other)
    expect(view.host.querySelector('[data-account-key]')?.getAttribute('data-account-key')).toBe(other)
    expect(inputs()[0].value).toBe('acme')
    type(inputs()[0], 'other-workspace')
    view.draw(identity)
    expect(inputs()[0].value).toBe('keep-me')
    expect(inputs()[1].value).toBe('')
})

it('writes nothing on Cancel before submit and keeps an uncertain submit for reconciliation', async () => {
    const view = render('new:fixture')
    const inputs = () => [...view.host.querySelectorAll('input')]
    type(inputs()[0], 'acme')
    type(inputs()[1], 'fixture-header-value')
    const cancel = [...view.host.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!
    act(() => cancel.click())
    expect(view.onSubmit).not.toHaveBeenCalled()
    expect(view.onCancel).toHaveBeenCalledTimes(1)
    type(inputs()[0], 'acme')
    type(inputs()[1], 'fixture-header-value')
    let release: () => void = () => {}
    view.onSubmit.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const save = [...view.host.querySelectorAll('button')].find(button => button.textContent === 'Install')!
    await act(async () => { save.click() })
    act(() => cancel.click())
    expect(view.host.textContent).toContain('Setup acknowledgement unavailable. Retry uses the same account.')
    expect(view.host.textContent).toContain('This attempt is kept for reconciliation.')
    expect(view.onCancel).toHaveBeenCalledTimes(1)
    await act(async () => { release() })
})

it('drops a late failure after the account identity changes', async () => {
    const first = '00000000-0000-4000-8000-000000000031'
    const second = '00000000-0000-4000-8000-000000000032'
    let reject: (error: Error) => void = () => {}
    const view = render(first, { saved: saved(first), onSubmit: () => new Promise((_, next) => { reject = next }) })
    const save = [...view.host.querySelectorAll('button')].find(button => button.textContent === 'Install')!
    await act(async () => { save.click() })
    view.draw(second)
    await act(async () => { reject(new Error('fixture-header-value failed')) })
    expect(view.host.querySelector('[role="alert"]')?.textContent ?? '').not.toContain('fixture-header-value')
    expect(view.host.querySelector('[data-account-key]')?.getAttribute('data-account-key')).toBe(second)
})

it('does not offer hosted sign-in for an unsupported method', () => {
    const oauth: ServiceAccountMethod = { ...method, id: 'oauth', label: 'OAuth', kind: 'oauth', inputs: [], requiresSecrets: false, availability: { id: 'oauth', supported: false, reason: 'Hosted OAuth is unavailable locally' } }
    const view = render('new:fixture', { methods: [oauth] })
    expect(view.host.querySelector('input')).toBeNull()
    expect(view.host.textContent).toContain('Hosted OAuth is unavailable locally')
    expect([...view.host.querySelectorAll('button')].some(button => button.textContent === 'Install')).toBe(false)
})
