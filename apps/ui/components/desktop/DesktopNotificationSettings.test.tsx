// @vitest-environment happy-dom
// Authored for the notifications lane; the integration owner runs all validation.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DESKTOP_NOTIFICATION_PREFS_URL } from '@/lib/desktop/notifications'
import { DesktopNotificationSettings } from './DesktopNotificationSettings'
import { mergeNotificationPrefs, normalizeNotificationPrefs } from '@rerun/contracts'

const lifecycle = vi.hoisted(() => ({ quitting: false, held: 0 }))
vi.mock('@/lib/desktop/draft-writes', () => ({
    isDesktopQuitting: () => lifecycle.quitting,
    holdDraftAdmission: () => { lifecycle.held++; return () => { lifecycle.held-- } },
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const dialog = () => document.body
const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
const switches = () => [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
const rowLabels = () => [...document.querySelectorAll('h3')].map(heading => heading.textContent?.trim())
const coworkers = [
    { id: 'researcher', name: 'Reviewer' },
    { id: 'writer', name: 'Reviewer Two' },
]
const defaults = { version: 2, scope: 'mine', toast: true, sound: true, email: true, coworkers: {}, tasks: {}, categories: { billing: true, product: true } }

let stored: unknown
let putReply: Response | undefined

afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    lifecycle.quitting = false
    vi.unstubAllGlobals(); vi.restoreAllMocks()
})

async function render(initial: unknown = defaults, reply?: Response) {
    stored = initial
    putReply = reply
    const putsLocal: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && String(url).endsWith('/api/desktop/agents')) return Response.json({ agents: coworkers.map(item => ({ ...item, description: '', enabled: true, createdAt: '', updatedAt: '' })) })
        if (method === 'GET') return Response.json(stored)
        const patch = JSON.parse(String(init?.body))
        putsLocal.push(patch)
        stored = mergeNotificationPrefs(normalizeNotificationPrefs(stored), patch)
        return putReply?.clone() ?? Response.json(stored)
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<DesktopNotificationSettings />) })
    return { puts: putsLocal }
}

test('renders the original scope labels with the recommended default, and the two local channels only', async () => {
    await render()
    expect(dialog().textContent).toContain('Notify me about')
    for (const label of ['Everything', 'My runs and what I follow', 'Only when I am needed', 'Nothing', 'Recommended']) {
        expect(dialog().textContent).toContain(label)
    }
    expect(rowLabels()).toEqual(['Notify me about', 'How', 'Per coworker'])
    const labels = switches().map(switchEl => switchEl.getAttribute('aria-label'))
    expect(labels).toEqual(['Desktop notification', 'Sound'])
    expect(dialog().textContent).not.toContain('Email')
    expect(dialog().textContent).not.toContain('Account emails')
    expect(dialog().textContent).toContain('Every coworker follows the rule above.')
})

test('scope and channel switches merge through the authoritative route response', async () => {
    const merged = { ...defaults, scope: 'everything', toast: false }
    const { puts } = await render(defaults, Response.json(merged))
    await act(async () => { radios().find(radio => radio.textContent?.includes('Everything'))!.click() })
    expect(puts[0]).toEqual({ scope: 'everything' })
    await act(async () => { switches()[1].click() })
    expect(puts[1]).toEqual({ sound: false })
    expect(dialog().textContent).toContain('Only when a coworker needs you or something breaks.')
})

test('adding a coworker rule picks from the local roster and resets through its own control', async () => {
    const { puts } = await render()
    await act(async () => { [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Add')!.click() })
    await act(async () => { dialog().querySelector<HTMLButtonElement>('[aria-label="Choose a coworker"]')!.click() })
    const options = [...document.querySelectorAll('[role="option"]')].map(option => option.textContent?.trim())
    expect(options).toEqual(['Reviewer', 'Reviewer Two'])
    await act(async () => {
        const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.trim() === 'Reviewer')!
        option.click()
    })
    expect(puts.at(-1)).toEqual({ coworkers: { researcher: { mode: 'everything' } } })
    await act(async () => {
        const reset = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Reset Reviewer')!
        reset.click()
    })
    expect(puts.at(-1)).toEqual({ coworkers: { researcher: { mode: 'default' } } })
})

test('a failed save surfaces the error and keeps the drafted values', async () => {
    const { puts } = await render(defaults, Response.json({ error: 'Could not save your notification settings. Try again.' }, { status: 503 }))
    await act(async () => { radios().find(radio => radio.textContent?.includes('Nothing'))!.click() })
    expect(puts[0]).toEqual({ scope: 'nothing' })
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Could not save your notification settings. Try again.')
    expect(dialog().textContent).toContain('Nothing')
    expect(lifecycle.held).toBe(0)
})

test('Quit rejects new changes and waits for an already admitted write receipt', async () => {
    await render()
    let finish!: (response: Response) => void
    const previous = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => init?.method === 'PUT'
        ? new Promise<Response>(resolve => { finish = resolve }) : previous(url, init)))
    await act(async () => { switches()[1]!.click() })
    expect(lifecycle.held).toBe(1)
    lifecycle.quitting = true
    await act(async () => { radios().find(radio => radio.textContent?.includes('Everything'))!.click() })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    await act(async () => finish(Response.json({ ...defaults, sound: false })))
    expect(lifecycle.held).toBe(0)
})
