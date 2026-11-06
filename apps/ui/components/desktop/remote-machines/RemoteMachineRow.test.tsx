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
        const element = [...document.querySelectorAll(role === 'button' ? 'button' : `[role="${role}"]`)].find(candidate => !options || candidate.getAttribute('aria-label') === options.name || candidate.textContent?.trim() === options.name)
        if (!element) throw new Error('Missing ' + role)
        return element
    },
}
const fireEvent = { click: (element: Element) => act(() => { (element as HTMLElement).click() }) }

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRemoteConnection, DesktopRemoteHealth, DesktopRemoteSnapshot } from '@rerun/contracts'
import { remoteMachineDescription, REMOTE_HEALTH_PRESENTATION, RemoteMachineRow } from './RemoteMachineRow'

afterEach(() => {
    for (const { root, host } of roots.splice(0)) {
        act(() => root.unmount())
        host.remove()
    }
    vi.restoreAllMocks()
})

const actor = { installId: '11111111-1111-4111-8111-111111111111', workspaceId: 1, launchNonce: '22222222-2222-4222-8222-222222222222', rendererEpoch: '33333333-3333-4333-8333-333333333333' }
const connection = (health: DesktopRemoteHealth): DesktopRemoteConnection => ({
    connectionId: '44444444-4444-4444-8444-444444444444',
    revision: '55555555-5555-4555-8555-555555555555',
    workspaceId: 1,
    address: 'https://machine.example',
    identity: { protocolVersion: 1, machineId: '66666666-6666-4666-8666-666666666666', workspaceId: 1 },
    credentialConfigured: true,
    removable: true,
    health,
})
const health: DesktopRemoteHealth = { state: 'connected', checkedAt: '2026-11-06T00:00:00.000Z', commit: 'abc1234', activeAgents: 3, reason: null }
const snapshot = (overrides: Partial<DesktopRemoteSnapshot> = {}): DesktopRemoteSnapshot => ({ version: 1, actor, revision: connection(health).revision, connection: connection(health), selected: true, openReceipt: null, ...overrides })

const noop = () => {}

describe('RemoteMachineRow', () => {
    it('shows the connected badge and the coworkers description', () => {
        render(<RemoteMachineRow snapshot={snapshot()} busy={null} onRemove={noop} onReplace={noop} onSelect={noop} onRecover={noop} onCancel={noop} onHealthCheck={noop} />)
        expect(document.body.textContent).toContain("This workspace's server")
        expect(document.body.textContent).toContain('Connected')
        expect(document.body.textContent).toContain('https://machine.example · 3 coworkers running · abc1234')
    })

    it('maps every canonical health state to truthful copy', () => {
        const cases: Array<[DesktopRemoteHealth['state'], string, string]> = [
            ['unreachable', 'Unreachable', 'the app cannot reach it right now'],
            ['auth_needed', 'Needs a key', 'the key was refused'],
            ['identity_changed', 'Identity changed', 'the machine identity changed'],
            ['unsupported', 'Unsupported version', 'does not provide a verifiable workspace identity'],
            ['not_checked', 'Checking…', 'health not checked yet'],
            ['cancelled', 'Checking stopped', 'checking stopped'],
        ]
        for (const [state, badge, text] of cases) {
            const host = document.createElement('div')
            document.body.append(host)
            const root = createRoot(host)
            roots.push({ root, host })
            act(() => root.render(<RemoteMachineRow snapshot={snapshot({ connection: connection({ ...health, state, commit: null, activeAgents: null }) })} busy={null} onRemove={noop} onReplace={noop} onSelect={noop} onRecover={noop} onCancel={noop} onHealthCheck={noop} />))
            expect(host.textContent).toContain(badge)
            expect(host.textContent).toContain(text)
        }
        expect(REMOTE_HEALTH_PRESENTATION.not_checked.tone).toBe('neutral')
    })

    it('offers Use this connection when the machine is not the selected one', () => {
        const onSelect = vi.fn()
        render(<RemoteMachineRow snapshot={snapshot({ selected: false })} busy={null} onRemove={noop} onReplace={noop} onSelect={onSelect} onRecover={noop} onCancel={noop} onHealthCheck={noop} />)
        fireEvent.click(screen.getByRole('button', { name: 'Use this connection' }))
        expect(onSelect).toHaveBeenCalledTimes(1)
    })

    it('shows Check again while the machine is not connected', () => {
        const onHealthCheck = vi.fn()
        render(<RemoteMachineRow snapshot={snapshot({ connection: connection({ ...health, state: 'unreachable', commit: null, activeAgents: null }) })} busy={null} onRemove={noop} onReplace={noop} onSelect={noop} onRecover={noop} onCancel={noop} onHealthCheck={onHealthCheck} />)
        fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
        expect(onHealthCheck).toHaveBeenCalledTimes(1)
        expect(document.body.textContent).not.toContain('Connected')
    })

    it('opens remove through the exact confirmation gate', () => {
        const onRemove = vi.fn()
        render(<RemoteMachineRow snapshot={snapshot()} busy={null} onRemove={onRemove} onReplace={noop} onSelect={noop} onRecover={noop} onCancel={noop} onHealthCheck={noop} />)
        fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
        expect(onRemove).toHaveBeenCalledTimes(1)
    })

    it('switches to recovery actions when the last change stalled', () => {
        const onRecover = vi.fn()
        const onCancel = vi.fn()
        render(<RemoteMachineRow snapshot={snapshot({ openReceipt: { version: 1, receiptId: '77777777-7777-4777-8777-777777777777', requestId: '88888888-8888-4888-8888-888888888888', installId: actor.installId, workspaceId: 1, kind: 'replace', connectionId: connection(health).connectionId, expectedRevision: 'unconfigured', revision: connection(health).revision, phase: 'failed_after_drain', effectGeneration: 0, closeAttempted: true, requiresRecovery: true, reason: null, createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z' } })} busy={null} onRemove={noop} onReplace={noop} onSelect={noop} onRecover={onRecover} onCancel={onCancel} onHealthCheck={noop} />)
        expect(document.body.textContent).toContain('Retry recovery')
        fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }))
        expect(onRecover).toHaveBeenCalledTimes(1)
        expect(document.body.textContent).not.toContain('Replace')
    })

    it('disables actions while a change is in flight', () => {
        render(<RemoteMachineRow snapshot={snapshot({ selected: false })} busy={{ kind: 'select', requestId: 'r' }} onRemove={noop} onReplace={noop} onSelect={noop} onRecover={noop} onCancel={noop} onHealthCheck={noop} />)
        for (const button of [...document.querySelectorAll('button')]) {
            expect((button as HTMLButtonElement).disabled).toBe(true)
        }
    })
})

describe('remoteMachineDescription', () => {
    it('truncates the commit to seven characters like the original row', () => {
        expect(remoteMachineDescription(connection({ ...health, commit: '0123456789' }))).toContain('· 0123456')
    })
})
