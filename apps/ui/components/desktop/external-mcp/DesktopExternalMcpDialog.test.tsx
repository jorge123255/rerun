// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExternalMcpCreateInput, ExternalMcpCreateResult, ExternalMcpKeyView, ExternalMcpListenerView, ExternalMcpRevokeInput } from '@rerun/contracts'
import { DesktopExternalMcpDialog } from './DesktopExternalMcpDialog'
import type { DesktopExternalMcpAttempt, DesktopExternalMcpDriver } from '@/lib/desktop/external-mcp/driver'

let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.restoreAllMocks() })

const key = (name = 'Claude Code'): ExternalMcpKeyView => ({
    version: 1, keyId: '123e4567-e89b-42d3-a456-426614174010', workspaceId: 1, name, keyPrefix: 'rk_123456789', scopes: ['mcp:read'], status: 'active', expiresAt: null, revokedAt: null,
    createdAt: '2026-11-01T00:00:00.000Z', lastUsedAt: null, revision: 1,
})
const listener = (enabled = true): ExternalMcpListenerView => ({ version: 1, enabled, origin: enabled ? 'http://127.0.0.1:43123' : null, path: '/mcp', workspaceId: 1, installId: '123e4567-e89b-42d3-a456-426614174000', launchNonce: '123e4567-e89b-42d3-a456-426614174001' })
const created = (input: ExternalMcpCreateInput, secretAvailable = true): ExternalMcpCreateResult => ({
    ok: true, recovered: !secretAvailable, secretAvailable, secret: secretAvailable ? 'rk_one_time_secret' : null, key: { ...key(input.name), scopes: input.scopes, expiresAt: input.expiresAt },
    receipt: { version: 1, receiptId: '123e4567-e89b-42d3-a456-426614174011', requestId: input.requestId, kind: 'create', status: 'recorded', workspaceId: 1, keyId: '123e4567-e89b-42d3-a456-426614174010', keyRevision: 1, installId: '123e4567-e89b-42d3-a456-426614174000', launchNonce: '123e4567-e89b-42d3-a456-426614174001', fingerprint: 'a'.repeat(64), message: 'Created', secretAvailable, createdAt: '2026-11-06T00:00:00.000Z' }, message: 'Created',
})

function harness(overrides: { keys?: ExternalMcpKeyView[]; listener?: ExternalMcpListenerView; create?: (input: ExternalMcpCreateInput) => Promise<ExternalMcpCreateResult> } = {}) {
    let attempts: DesktopExternalMcpAttempt[] = []
    let keys = overrides.keys ?? []
    const calls = { create: 0, revoke: 0, enable: 0, disable: 0, reserve: 0 }
    const driver: DesktopExternalMcpDriver = {
        list: async () => ({ version: 1, workspaceId: 1, keys }),
        listener: async () => overrides.listener ?? listener(),
        create: vi.fn(async input => { calls.create++; return overrides.create ? overrides.create(input) : created(input) }),
        revoke: vi.fn(async (input: ExternalMcpRevokeInput) => {
            calls.revoke++
            const selected = keys.find(item => item.keyId === input.keyId)!
            keys = keys.filter(item => item.keyId !== input.keyId)
            return { ok: true as const, recovered: false, key: { ...selected, status: 'revoked' as const, revokedAt: '2026-11-06T00:00:00.000Z', revision: selected.revision + 1 }, receipt: { ...created({ requestId: input.requestId, workspaceId: 1, name: selected.name, scopes: selected.scopes, expiresAt: selected.expiresAt }).receipt, kind: 'revoke' as const, requestId: input.requestId } }
        }),
        enable: vi.fn(async input => { calls.enable++; return { ok: true as const, recovered: false, listener: listener(true), receipt: { ...created({ requestId: input.requestId, workspaceId: 1, name: 'listener', scopes: ['mcp:read'], expiresAt: null }).receipt, kind: 'enable' as const, requestId: input.requestId } } }),
        disable: vi.fn(async input => { calls.disable++; return { ok: true as const, recovered: false, listener: listener(false), receipt: { ...created({ requestId: input.requestId, workspaceId: 1, name: 'listener', scopes: ['mcp:read'], expiresAt: null }).receipt, kind: 'disable' as const, requestId: input.requestId } } }),
        attempts: {
            list: async () => attempts,
            reserve: async attempt => { calls.reserve++; const prior = attempts.find(item => item.kind === attempt.kind && item.input.requestId === attempt.input.requestId); if (prior && JSON.stringify(prior) !== JSON.stringify(attempt)) throw new Error('conflict'); if (!prior) attempts = [...attempts, attempt]; return attempt },
            clear: async attempt => { attempts = attempts.filter(item => item.input.requestId !== attempt.input.requestId) },
        },
    }
    return { driver, calls, getAttempts: () => attempts }
}

async function mount(driver: DesktopExternalMcpDriver, workspaceId = 1) {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopExternalMcpDialog open workspaceId={workspaceId} onOpenChange={() => {}} driver={driver} />))
}
async function click(label: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(label) || item.getAttribute('aria-label') === label)
    expect(button, label).toBeTruthy()
    await act(async () => button!.click())
}
async function input(label: string, value: string) {
    const field = [...document.querySelectorAll<HTMLInputElement>('input')].find(item => item.getAttribute('aria-label') === label || item.id === label || item.placeholder === label)
    expect(field, label).toBeTruthy()
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(field, value)
        field!.dispatchEvent(new Event('input', { bubbles: true }))
    })
}
async function enter(label: string) {
    const field = [...document.querySelectorAll<HTMLInputElement>('input')].find(item => item.placeholder === label)
    expect(field, label).toBeTruthy()
    await act(async () => field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
}

it('creates with default read-only scope, shows the secret once, and never auto-enables the listener', async () => {
    const { driver, calls } = harness({ listener: listener(false) })
    await mount(driver)
    expect(calls.enable).toBe(0)
    await click('Enable local listener')
    expect(calls.enable).toBe(1)
    await input('Claude Code, MacBook', 'My client')
    await enter('Claude Code, MacBook')
    expect(calls.create).toBe(1)
    const request = vi.mocked(driver.create).mock.calls[0]![0]
    expect(request.scopes).toEqual(['mcp:read'])
    expect(request.expiresAt).toBeNull()
    expect(document.body.textContent).toContain('Copy this key now. It will never be shown again.')
    expect(document.body.textContent).toContain('rk_one_time_secret')
    expect(document.body.textContent).toContain('http://127.0.0.1:43123/mcp')
    await click('Hide key')
    expect(document.body.textContent).not.toContain('rk_one_time_secret')
    await click('Reveal key')
    expect(document.body.textContent).toContain('rk_one_time_secret')
    await click('I copied it')
    expect(document.body.textContent).not.toContain('rk_one_time_secret')
})

it('retries a lost create acknowledgement with the durable same request ID', async () => {
    let fail = true
    const ids: string[] = []
    const { driver } = harness({ create: async input => {
        ids.push(input.requestId)
        if (fail) { fail = false; throw new Error('lost acknowledgement') }
        return created(input)
    } })
    await mount(driver)
    await input('Claude Code, MacBook', 'Recover me')
    await click('Create key')
    expect(document.body.textContent).toContain('Retry request')
    await click('Retry request')
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(document.body.textContent).toContain('rk_one_time_secret')
})

it('does not resurface a recovered or discarded secret', async () => {
    const { driver } = harness({ create: async input => created(input, false) })
    await mount(driver)
    await input('Claude Code, MacBook', 'Already acknowledged')
    await click('Create key')
    expect(document.body.textContent).toContain('secret was already discarded')
    expect(document.body.textContent).not.toContain('rk_one_time_secret')
})

it('keeps revoke behind confirmation, supports Cancel, and revokes on explicit confirm', async () => {
    const { driver, calls } = harness({ keys: [key()] })
    await mount(driver)
    await click('Revoke this key')
    expect(document.body.textContent).toContain('Revoke this key?')
    await click('Cancel')
    expect(calls.revoke).toBe(0)
    await click('Revoke this key')
    const dialog = document.querySelector('[role="alertdialog"]') ?? document.body
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Revoke')
    await act(async () => confirm!.click())
    expect(calls.revoke).toBe(1)
    expect(document.body.textContent).toContain('No key yet')
})

it('renders expired state and never puts a previous workspace key on a workspace switch', async () => {
    const expired = { ...key('Old workspace'), status: 'expired' as const, expiresAt: '2026-11-01T00:00:00.000Z' }
    const first = harness({ keys: [expired] })
    await mount(first.driver, 1)
    expect(document.body.textContent).toContain('Old workspace')
    expect(document.body.textContent).toContain('Expired')
    const second = harness({ keys: [] })
    await act(async () => root!.render(<DesktopExternalMcpDialog open workspaceId={2} onOpenChange={() => {}} driver={second.driver} />))
    expect(document.body.textContent).not.toContain('Old workspace')
    expect(document.body.textContent).toContain('No key yet')
})

it('ignores a delayed list response from the previous workspace', async () => {
    let resolveFirst!: (value: { version: 1; workspaceId: number; keys: ExternalMcpKeyView[] }) => void
    const first = harness()
    first.driver.list = () => new Promise(resolve => { resolveFirst = resolve })
    await mount(first.driver, 1)
    const second = harness({ keys: [] })
    await act(async () => root!.render(<DesktopExternalMcpDialog open workspaceId={2} onOpenChange={() => {}} driver={second.driver} />))
    await act(async () => resolveFirst({ version: 1, workspaceId: 1, keys: [key('Late old workspace')] }))
    expect(document.body.textContent).not.toContain('Late old workspace')
    expect(document.body.textContent).toContain('No key yet')
})

it('retries revoke with the same request ID after a lost acknowledgement', async () => {
    const { driver } = harness({ keys: [key()] })
    const acknowledged = driver.revoke
    const ids: string[] = []
    let fail = true
    driver.revoke = async input => {
        ids.push(input.requestId)
        if (fail) { fail = false; throw new Error('lost acknowledgement') }
        return acknowledged(input)
    }
    await mount(driver)
    await click('Revoke this key')
    const confirm = () => [...(document.querySelector('[role="alertdialog"]') ?? document.body).querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Revoke')!
    await act(async () => confirm().click())
    expect(document.body.textContent).toContain('lost acknowledgement')
    await act(async () => confirm().click())
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
})
