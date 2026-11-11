// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopSubscriptionLoginSnapshot } from '@rerun/contracts'
import { DesktopSubscriptionLogin } from './DesktopSubscriptionLogin'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.replaceChildren()
})

test('scopes the device-code controls to the installed provider and cancels an active attempt', async () => {
    let snapshot: DesktopSubscriptionLoginSnapshot = {
        'grok-build': { phase: 'idle' },
        'kimi-code': { phase: 'unavailable' },
    }
    const actions: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body))
            actions.push(body)
            snapshot = {
                ...snapshot,
                'grok-build': body.action === 'start'
                    ? { phase: 'waiting', userCode: 'TEST-QA22', verificationUrl: 'https://auth.x.ai/device' }
                    : { phase: 'idle' },
            }
        }
        return Response.json(snapshot)
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopSubscriptionLogin />) })
    const button = (text: string) => [...container.querySelectorAll('button')].find(node => node.textContent === text)!
    expect(container.textContent).not.toContain('Kimi Code')
    await act(async () => { button('Sign in with Grok Build').click() })
    expect(container.querySelector('output')?.textContent).toBe('TEST-QA22')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://auth.x.ai/device')
    await act(async () => { button('Cancel sign-in').click() })
    expect(container.querySelector('output')).toBeNull()
    expect(actions).toEqual([
        { provider: 'grok-build', action: 'start' },
        { provider: 'grok-build', action: 'cancel' },
    ])
    await act(async () => { root.unmount() })
})

test('shows a saved approval without claiming coworker chat is connected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
        'grok-build': { phase: 'unavailable' },
        'kimi-code': { phase: 'approved' },
    })))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopSubscriptionLogin />) })
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Sign-in approval saved')
    expect(container.querySelector('button')?.textContent).toBe('Disconnect Kimi Code from Rerun')
    expect(container.querySelector('output')).toBeNull()
    await act(async () => { root.unmount() })
})

test('refreshes the approved model catalog and removes it on disconnect', async () => {
    const changed = vi.fn()
    let state: DesktopSubscriptionLoginSnapshot = {
        'grok-build': { phase: 'unavailable' },
        'kimi-code': { phase: 'approved', canRefreshModels: true },
    }
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            const { provider, action } = JSON.parse(String(init.body))
            expect(provider).toBe('kimi-code')
            state = { ...state, 'kimi-code': action === 'refresh-models'
                ? { phase: 'approved', canRefreshModels: true, models: [{ id: 'kimi-fixture', label: 'Kimi Fixture' }] }
                : { phase: 'idle' } }
        }
        return Response.json(state)
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopSubscriptionLogin onConnectionsChanged={changed} />) })
    const button = (text: string) => [...container.querySelectorAll('button')].find(node => node.textContent === text)!
    await act(async () => { button('Load models').click() })
    expect(container.textContent).toContain('Ready for text chat')
    expect(changed).toHaveBeenCalledTimes(1)
    await act(async () => { button('Disconnect Kimi Code from Rerun').click() })
    expect(container.textContent).toContain('Sign in with Kimi Code')
    expect(changed).toHaveBeenCalledTimes(2)
    await act(async () => { root.unmount() })
})
