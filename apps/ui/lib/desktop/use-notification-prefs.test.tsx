// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DEFAULT_NOTIFICATION_PREFS, mergeNotificationPrefs, normalizeNotificationPrefs, type NotificationPrefs } from '@rerun/contracts'
import { DESKTOP_NOTIFICATION_PREFS_URL } from './notifications'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

let root: Root | undefined
let stored: NotificationPrefs = normalizeNotificationPrefs(undefined)
let failPut = false
let hook: ReturnType<typeof import('./use-notification-prefs').useDesktopNotificationPrefs>

beforeEach(() => {
    vi.resetModules()
    toastError.mockReset()
    stored = normalizeNotificationPrefs({ ...DEFAULT_NOTIFICATION_PREFS, scope: 'everything' })
    failPut = false
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url !== DESKTOP_NOTIFICATION_PREFS_URL) throw new Error(`Unexpected request ${url}`)
        if (!init?.method || init.method === 'GET') return Response.json(stored)
        if (failPut) return Response.json({ error: 'nope' }, { status: 500 })
        const patch = JSON.parse(String(init.body))
        stored = mergeNotificationPrefs(stored, patch)
        return Response.json(stored)
    }))
})

afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    root = undefined; hook = undefined as never
    document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers()
})

async function mount() {
    const { useDesktopNotificationPrefs } = await import('./use-notification-prefs')
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    function Bound() { hook = useDesktopNotificationPrefs(); return null }
    await act(async () => { root?.render(<Bound />) })
}

test('loads the stored preferences and exposes the shared rule lookups', async () => {
    await mount()
    expect(hook.prefs.scope).toBe('everything')
    expect(hook.ruleOf('agent-a')).toEqual({ mode: 'default' })
    expect(hook.ready).toBe(true)
})

test('an update merges onto stored, stays optimistic and writes only the patch', async () => {
    await mount()
    await act(async () => { hook.update({ scope: 'nothing' }) })
    expect(hook.prefs.scope).toBe('nothing')
    await act(async () => {})
    expect(stored.scope).toBe('nothing')
    const put = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ scope: 'nothing' })
})

test('setCoworkerRule writes the exact coworker rule and ruleOf reflects it', async () => {
    await mount()
    await act(async () => { hook.setCoworkerRule('agent-a', { mode: 'muted' }) })
    await act(async () => {})
    expect(stored.coworkers['agent-a']).toEqual({ mode: 'muted' })
    expect(hook.ruleOf('agent-a').mode).toBe('muted')
})

test('a failed write reverts the optimistic value and reports the error', async () => {
    await mount()
    failPut = true
    await act(async () => { hook.update({ scope: 'nothing' }) })
    await act(async () => {})
    expect(hook.prefs.scope).toBe('everything')
    expect(toastError).toHaveBeenCalled()
})

test('two quick updates serialize and both land', async () => {
    await mount()
    await act(async () => {
        hook.update({ scope: 'mine' })
        hook.update({ sound: false })
    })
    await act(async () => {})
    expect(stored.scope).toBe('mine')
    expect(stored.sound).toBe(false)
})
