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
async function waitFor(check: () => void, rounds = 14) {
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
const screen = {
    getByRole: (role: string, options?: { name: string }) => {
        const element = [...document.querySelectorAll(role === 'button' ? 'button' : `[role="${role}"]`)].find(candidate => !options || candidate.getAttribute('aria-label') === options.name || candidate.textContent?.trim() === options.name)
        if (!element) throw new Error('Missing ' + role)
        return element
    },
}
const click = (element: Element) => act(() => { (element as HTMLElement).click() })
const pointerClick = async (element: Element) => {
    await act(async () => { element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })) })
    await click(element)
}
const setValue = (element: Element, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
const inputByPlaceholder = (placeholder: string) => [...document.querySelectorAll<HTMLInputElement>('input')].find(input => input.placeholder === placeholder)
const alertDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
const alertDialogButton = (label: string) => [...alertDialog()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)!

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRemoteActor } from '@rerun/contracts'
import { RemoteMachinesDialog } from './RemoteMachinesDialog'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
// The outer dialog plumbing is radix's; this lane owns the content, the pair/replace/remove
// envelopes and the confirmation gates, so the Dialog is reduced to passthrough markup while the
// real ConfirmDialog (radix AlertDialog) stays mounted, like the inbox confirmation precedent.
vi.mock('@/components/ui/dialog', () => ({
    Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}))

import { remoteActor as seed, remoteConnection as connection, remoteReceipt as receipt, emptyRemoteSnapshot as empty, connectedRemoteSnapshot as connected } from '@/lib/desktop/remote-machines/remote-machines.test-support'

type Envelope = Record<string, unknown> & { action: string; actor: DesktopRemoteActor }
const key = 'engine-key-1234567890123456'

function fixture(initial: 'connected' | 'empty') {
    const envelopes: Envelope[] = [], healthProbes: Envelope[] = []
    let hasConnection = initial === 'connected', selected = initial === 'connected'
    let currentConnection = { ...connection }, activeReceipt = receipt
    const view = (actor: DesktopRemoteActor) => hasConnection ? connected(actor, { connection: currentConnection, selected, runtimeState: selected ? 'connected' : 'not_connected', activeReceipt: selected ? activeReceipt : null }) : empty(actor)
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Envelope
        envelopes.push(body)
        if (body.action === 'health') healthProbes.push(body)
        if (body.action === 'read') return Response.json({ ok: true, snapshot: view(body.actor), receipt: null })
        const effect = { ...receipt, requestId: body.requestId, kind: body.action, connectionId: body.connectionId ?? currentConnection.connectionId,
            expectedRevision: body.expectedRevision ?? currentConnection.revision }
        if (body.action === 'pair' || body.action === 'replace') {
            selected = body.action === 'replace' && selected
            currentConnection = { ...connection, connectionId: String(body.connectionId), address: String(body.address) }
            hasConnection = true
            if (selected) activeReceipt = effect as typeof receipt
        }
        if (body.action === 'remove') { hasConnection = false; selected = false }
        return Response.json({ ok: true, snapshot: view(body.actor), receipt: effect })
    })
    vi.stubGlobal('fetch', fetchMock)
    return { fetchMock, envelopes, healthProbes }
}

afterEach(() => {
    for (const { root, host } of roots.splice(0)) {
        act(() => root.unmount())
        host.remove()
    }
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const mount = () => render(<RemoteMachinesDialog open onOpenChange={() => {}} actor={seed} />)

describe('RemoteMachinesDialog', () => {
    it('loads and shows the connected machine row', async () => {
        fixture('connected')
        mount()
        await waitFor(() => expect(document.body.textContent).toContain("This workspace's server"))
        expect(document.body.textContent).toContain('Connected')
        expect(document.body.textContent).toContain('https://machine.example · 3 coworkers running · abc1234')
    })

    it('shows the add form when no machine is attached', async () => {
        fixture('empty')
        mount()
        await waitFor(() => expect(document.body.textContent).toContain('Add a server'))
        expect(document.body.textContent).toContain('Enter address and key')
    })

    it('connects over the manual form and posts the pair envelope', async () => {
        const { envelopes } = fixture('empty')
        mount()
        await waitFor(() => expect(document.body.textContent).toContain('Add a server'))
        await click(screen.getByRole('button', { name: 'Enter address and key' }))
        setValue(inputByPlaceholder('https://your-server.example.com')!, 'https://machine.example')
        setValue(inputByPlaceholder('RERUN_API_KEY of the engine')!, key)
        await click(screen.getByRole('button', { name: 'Connect' }))
        await waitFor(() => expect(envelopes.some(envelope => envelope.action === 'pair')).toBe(true))
        const pair = envelopes.find(envelope => envelope.action === 'pair')!
        expect(pair).toMatchObject({ address: 'https://machine.example', apiKey: key, expectedRevision: 'unconfigured' })
        await waitFor(() => expect(document.body.textContent).toContain('Saved server'))
        expect(document.body.textContent).toContain('Not in use')
    })

    it('replacing an existing machine goes through the confirmation gate and posts the exact revision', async () => {
        const { envelopes } = fixture('connected')
        mount()
        await waitFor(() => expect(document.body.textContent).toContain("This workspace's server"))
        await click(screen.getByRole('button', { name: 'Replace' }))
        await click(screen.getByRole('button', { name: 'Enter address and key' }))
        setValue(inputByPlaceholder('https://your-server.example.com')!, 'https://next.example')
        setValue(inputByPlaceholder('RERUN_API_KEY of the engine')!, key)
        await click(screen.getByRole('button', { name: 'Connect' }))
        await waitFor(() => expect(alertDialog()).not.toBeNull())
        expect(alertDialog()!.textContent).toContain('Replace this server?')
        await pointerClick(alertDialogButton('Replace'))
        await waitFor(() => expect(envelopes.some(envelope => envelope.action === 'replace')).toBe(true))
        const replace = envelopes.find(envelope => envelope.action === 'replace')!
        expect(replace).toMatchObject({ connectionId: connection.connectionId, expectedRevision: connection.revision, address: 'https://next.example', apiKey: key })
        expect(envelopes.some(envelope => envelope.action === 'pair')).toBe(false)
    })

    it('removing confirms with the original copy and posts the remove envelope', async () => {
        const { envelopes } = fixture('connected')
        mount()
        await waitFor(() => expect(document.body.textContent).toContain("This workspace's server"))
        await click(screen.getByRole('button', { name: 'Remove' }))
        await waitFor(() => expect(alertDialog()).not.toBeNull())
        expect(alertDialog()!.textContent).toContain('Remove this server?')
        expect(alertDialog()!.textContent).toContain('attach it again to get them back')
        await pointerClick(alertDialogButton('Remove'))
        await waitFor(() => expect(envelopes.some(envelope => envelope.action === 'remove')).toBe(true))
        const remove = envelopes.find(envelope => envelope.action === 'remove')!
        expect(remove).toMatchObject({ connectionId: connection.connectionId, expectedRevision: connection.revision, confirmation: 'Remove' })
        await waitFor(() => expect(document.body.textContent).toContain('Add a server'))
    })

    it('shows the truthful unavailable state when the lifecycle authority is missing', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, code: 'authority_missing', message: 'This remote-machine capability is not connected to the desktop lifecycle.', receipt: null })))
        mount()
        await waitFor(() => expect(document.body.textContent).toContain('not connected to the desktop lifecycle'))
        expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
    })

    it('opening is observational and health runs only after Check again', async () => {
        const { healthProbes } = fixture('connected')
        mount()
        await waitFor(() => expect(document.body.textContent).toContain("This workspace's server"))
        expect(healthProbes).toHaveLength(0)
        await click(screen.getByRole('button', { name: 'Check again' }))
        await waitFor(() => expect(healthProbes).toHaveLength(1))
        await act(async () => {})
        expect(healthProbes).toHaveLength(1)
    })
})
