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
import type { DesktopRemoteActor, DesktopRemoteSnapshot } from '@rerun/contracts'
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
}))

const seed = { installId: '11111111-1111-4111-8111-111111111111', workspaceId: 1, launchNonce: '22222222-2222-4222-8222-222222222222' }
const connection = {
    connectionId: '33333333-3333-4333-8333-333333333333',
    revision: '44444444-4444-4444-8444-444444444444',
    workspaceId: 1,
    address: 'https://machine.example',
    identity: { protocolVersion: 1, machineId: '55555555-5555-4555-8555-555555555555', workspaceId: 1 },
    credentialConfigured: true,
    removable: true,
    health: { state: 'connected', checkedAt: '2026-11-06T00:00:00.000Z', commit: 'abc1234', activeAgents: 3, reason: null },
}
const receipt = {
    version: 1,
    receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    installId: seed.installId,
    workspaceId: 1,
    kind: 'pair',
    connectionId: connection.connectionId,
    expectedRevision: 'unconfigured',
    revision: connection.revision,
    phase: 'published',
    effectGeneration: 0,
    closeAttempted: true,
    requiresRecovery: false,
    reason: null,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
}
const empty = (actor: DesktopRemoteActor): DesktopRemoteSnapshot => ({ version: 1, actor, revision: 'unconfigured', connection: null, selected: false, openReceipt: null })
const connected = (actor: DesktopRemoteActor, overrides: Partial<DesktopRemoteSnapshot> = {}): DesktopRemoteSnapshot => ({ version: 1, actor, revision: connection.revision, connection, selected: true, openReceipt: null, ...overrides })

type Envelope = Record<string, unknown> & { action: string; actor: DesktopRemoteActor }
const key = 'engine-key-1234567890123456'

function fixture(initial: 'connected' | 'empty') {
    const envelopes: Envelope[] = []
    const healthProbes: Envelope[] = []
    let hasConnection = initial === 'connected'
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Envelope
        envelopes.push(body)
        if (body.action === 'health') healthProbes.push(body)
        if (body.action === 'read' || body.action === 'health') {
            return Response.json({ ok: true, snapshot: hasConnection ? connected(body.actor) : empty(body.actor), receipt: null })
        }
        if (body.action === 'pair' || body.action === 'replace') {
            hasConnection = true
            return Response.json({ ok: true, snapshot: connected(body.actor), receipt: { ...receipt, kind: body.action } })
        }
        if (body.action === 'remove') {
            hasConnection = false
            return Response.json({ ok: true, snapshot: empty(body.actor), receipt: { ...receipt, kind: 'remove' } })
        }
        return Response.json({ ok: true, snapshot: connected(body.actor), receipt: null })
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
        setValue(inputByPlaceholder('http://192.168.1.20:3000')!, 'https://machine.example')
        setValue(inputByPlaceholder('RERUN_API_KEY of the engine')!, key)
        await click(screen.getByRole('button', { name: 'Connect' }))
        await waitFor(() => expect(envelopes.some(envelope => envelope.action === 'pair')).toBe(true))
        const pair = envelopes.find(envelope => envelope.action === 'pair')!
        expect(pair).toMatchObject({ address: 'https://machine.example', apiKey: key, expectedRevision: 'unconfigured' })
        await waitFor(() => expect(document.body.textContent).toContain("This workspace's server"))
    })

    it('replacing an existing machine goes through the confirmation gate and posts the exact revision', async () => {
        const { envelopes } = fixture('connected')
        mount()
        await waitFor(() => expect(document.body.textContent).toContain("This workspace's server"))
        await click(screen.getByRole('button', { name: 'Replace' }))
        await click(screen.getByRole('button', { name: 'Enter address and key' }))
        setValue(inputByPlaceholder('http://192.168.1.20:3000')!, 'https://next.example')
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

    it('probes health exactly once on open and stays observational afterwards', async () => {
        const { healthProbes } = fixture('connected')
        mount()
        await waitFor(() => expect(document.body.textContent).toContain("This workspace's server"))
        await waitFor(() => expect(healthProbes.length).toBe(1))
        await act(async () => {})
        expect(healthProbes.length).toBe(1)
    })
})
