// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DESKTOP_BROWSER_PRESS_TOOL } from '@rerun/contracts'
import { resetDesktopArrivalsForTest } from '../panel-motion/DesktopArrive'
import { DesktopConnectorApprovals } from './DesktopConnectorApprovals'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
beforeEach(() => { resetDesktopArrivalsForTest() })
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers() })

const send = { id: '11111111-1111-4111-8111-111111111111', tool: 'gmail_send_email', kind: 'send', preview: '{"to":"pat@example.test"}', createdAt: '2026-11-14T12:00:00.000Z' }
const press = { id: '33333333-3333-4333-8333-333333333333', tool: DESKTOP_BROWSER_PRESS_TOOL, kind: 'press', preview: JSON.stringify({ v: 1, items: [], press: { label: 'Place order', host: 'shop.example.test', via: 'click' } }), createdAt: '2026-11-14T12:01:00.000Z' }
const remove = { id: '44444444-4444-4444-8444-444444444444', tool: 'gdrive_delete_file', kind: 'delete', preview: '{}', createdAt: '2026-11-14T12:02:00.000Z' }

async function mount(first: unknown) {
    vi.useFakeTimers()
    let view = first
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(view)))
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    roots.push(root)
    const render = (sessionId: string) => act(async () => { root.render(<DesktopConnectorApprovals sessionId={sessionId} generating disabled={false} onAnswered={() => {}} coworkerName="Scout" />) })
    await render('chat-1')
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    return { host, render, next: async (value: unknown) => { view = value; await act(async () => { await vi.advanceTimersByTimeAsync(3_000) }) } }
}
const card = (host: HTMLElement) => host.querySelector<HTMLElement>('section[data-desktop-arrive]')

test('an approval that was already waiting when the conversation was opened is drawn settled', async () => {
    const { host } = await mount({ pending: [press], rules: [] })
    expect(card(host)!.dataset.desktopArrive).toBe('settled')
    expect(host.querySelector('[data-desktop-arrive-attention]')).toBeNull()
    expect(card(host)!.getAttribute('data-testid')).toBe('desktop-browser-press-approval')
    expect(card(host)!.getAttribute('aria-label')).toContain('Place order')
})

test('a browser press held during a reply slides in and shakes once; its buttons are there at once', async () => {
    const { host, next } = await mount({ pending: [], rules: [] })
    expect(card(host)).toBeNull()
    await next({ pending: [press], rules: [] })
    expect(card(host)!.dataset.desktopArrive).toBe('live')
    expect(card(host)!.classList.contains('motion-reduce:animate-none')).toBe(true)
    const shake = host.querySelector<HTMLElement>('[data-desktop-arrive-attention]')!
    expect(shake.className).toBe('desktop-attention-shake')
    expect([...shake.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Allow once', 'Deny'])
    // The next read brings the same request back: it does not play again.
    await next({ pending: [press], rules: [] })
    expect(host.querySelectorAll('[data-desktop-arrive-attention]')).toHaveLength(1)
})

test('a risky connector action shakes on arrival; an ordinary one only slides in', async () => {
    const { host, next } = await mount({ pending: [], rules: [] })
    await next({ pending: [send], rules: [] })
    expect(card(host)!.dataset.desktopArrive).toBe('live')
    expect(host.querySelector('[data-desktop-arrive-attention]')).toBeNull()
    await next({ pending: [remove], rules: [] })
    expect(card(host)!.dataset.desktopArrive).toBe('live')
    expect(host.querySelector('[data-desktop-arrive-attention]')).not.toBeNull()
})

test('another conversation starts over: what it already held does not slide in', async () => {
    const { host, render, next } = await mount({ pending: [], rules: [] })
    await next({ pending: [], rules: [] })
    vi.mocked(fetch).mockImplementation(async () => Response.json({ pending: [remove], rules: [] }))
    await render('chat-2')
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(card(host)!.dataset.desktopArrive).toBe('settled')
})
