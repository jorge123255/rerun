// @vitest-environment happy-dom

import type { ConnectionsList, DesktopCodexStatus } from '@rerun/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopCodexLogin } from './DesktopCodexLogin'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const providers: ConnectionsList = { connections: [], default: null }
const waiting: DesktopCodexStatus = {
    phase: 'waiting',
    userCode: 'TEST-CODE',
    verificationUrl: 'https://auth.openai.com/codex/device',
    expiresAt: Date.parse('2026-11-08T12:15:00.000Z'),
}

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
})

test('shows a device code that the status read publishes after the start response is lost', async () => {
    vi.useFakeTimers()
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return new Response('lost', { status: 500 })
        reads += 1
        const status: DesktopCodexStatus = reads < 3 ? { phase: 'idle' } : waiting
        return Response.json({ status, providers })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCodexLogin connected={false} modelCount={0} onProviders={() => {}} />) })
    await act(async () => { vi.advanceTimersByTime(0) })
    const button = () => [...container.querySelectorAll('button')].find(item => item.textContent?.includes('Sign in'))!
    await act(async () => { button().click() })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(container.querySelector('[aria-label="Device code"]')?.textContent).toBe('TEST-CODE')
    expect(container.textContent).not.toContain('Cannot reach the local Codex runner')
    await act(async () => { root.unmount() })
})

test('shows a device code from a successful start when the provider list is unavailable', async () => {
    let started = false
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') started = true
        const status = started ? waiting : { phase: 'idle' as const }
        return Response.json({ status, providers: init?.method === 'POST' ? null : providers })
    }))
    const onProviders = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCodexLogin connected={false} modelCount={0} onProviders={onProviders} />) })
    const button = () => [...container.querySelectorAll('button')].find(item => item.textContent?.includes('Sign in'))!
    await act(async () => { button().click() })
    expect(container.querySelector('[aria-label="Device code"]')?.textContent).toBe('TEST-CODE')
    expect(onProviders.mock.calls.some(([value]) => value == null)).toBe(false)
    await act(async () => { root.unmount() })
})

test('keeps a real sign-in failure, expiry, and cancellation instead of a device code', async () => {
    vi.useFakeTimers()
    const failure = { phase: 'error' as const, message: 'Could not start device sign-in. Check your network and try again.' }
    const expired = { phase: 'error' as const, message: 'This code expired. Request a new sign-in code.' }
    const queue = [
        { status: { phase: 'idle' as const }, providers },
        { status: failure, providers },
        { status: waiting, providers },
        { status: waiting, providers },
        { status: expired, providers },
        { status: waiting, providers },
        { status: waiting, providers },
        { status: { phase: 'idle' as const }, providers },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(queue.shift())))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCodexLogin connected={false} modelCount={0} onProviders={() => {}} />) })
    const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.includes(label))!
    await act(async () => { button('Sign in').click() })
    expect(container.textContent).toContain('Could not start device sign-in. Check your network and try again.')
    expect(container.querySelector('[aria-label="Device code"]')).toBeNull()

    await act(async () => { button('Sign in').click() })
    expect(container.querySelector('[aria-label="Device code"]')?.textContent).toBe('TEST-CODE')
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(container.textContent).toContain('This code expired. Request a new sign-in code.')
    expect(container.querySelector('[aria-label="Device code"]')).toBeNull()

    await act(async () => { button('Sign in').click() })
    expect(container.querySelector('[aria-label="Device code"]')?.textContent).toBe('TEST-CODE')
    await act(async () => { button('Cancel').click() })
    expect(container.querySelector('[aria-label="Device code"]')).toBeNull()
    expect(container.textContent).toContain('Sign in with ChatGPT')
    await act(async () => { root.unmount() })
})
