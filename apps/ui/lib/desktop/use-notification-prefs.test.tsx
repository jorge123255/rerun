// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { coworkerRuleOf, DEFAULT_NOTIFICATION_PREFS, mergeNotificationPrefs, normalizeNotificationPrefs, type NotificationPrefs } from '@rerun/contracts'
import { DESKTOP_NOTIFICATION_PREFS_URL, type DesktopNotificationRuleChange } from './notifications'

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
        if (init.method === 'PATCH') {
            const input = patch as DesktopNotificationRuleChange
            const rule = coworkerRuleOf(stored, input.agentId)
            if (rule[input.field] !== input.expected) return Response.json({ error: 'rule changed' }, { status: 409 })
            stored = mergeNotificationPrefs(stored, { coworkers: { [input.agentId]: { ...rule, [input.field]: input.value } } })
        } else {
            stored = mergeNotificationPrefs(stored, patch)
        }
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

test('conditional inbox changes share the settings write queue and refuse a stale Undo', async () => {
    await mount()
    const owner = { workspaceId: 7, agentId: 'agent-a' }
    await act(async () => {
        hook.setCoworkerRule(owner.agentId, { mode: 'everything', follow: true })
        expect(await hook.changeCoworkerRule({ ...owner, field: 'mode', expected: 'everything', value: 'muted' })).toBe(true)
    })
    expect(hook.ruleOf(owner.agentId)).toEqual({ mode: 'muted', follow: true })
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => init?.method).filter(Boolean)).toEqual(['PUT', 'PATCH'])

    await act(async () => {
        hook.setCoworkerRule(owner.agentId, { mode: 'default', follow: false })
        expect(await hook.changeCoworkerRule({ ...owner, field: 'mode', expected: 'muted', value: 'everything' })).toBe(false)
    })
    expect(hook.ruleOf(owner.agentId)).toEqual({ mode: 'default', follow: false })
    expect(toastError).toHaveBeenCalled()
})

test('a failed initial read never permits a write based on invented defaults', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'offline' }, { status: 503 })))
    await mount()
    expect(hook.ready).toBe(false)
    expect(hook.readError).toContain('Could not load')
    await act(async () => { hook.setCoworkerRule('agent-a', { mode: 'muted' }) })
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
})

test('all mounted surfaces share current rules and one write queue', async () => {
    const { useDesktopNotificationPrefs } = await import('./use-notification-prefs')
    let bell!: typeof hook, settings!: typeof hook
    function Bell() { bell = useDesktopNotificationPrefs(); return null }
    function Settings() { settings = useDesktopNotificationPrefs(); return null }
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root?.render(<><Bell /><Settings /></>))
    await act(async () => { settings.setCoworkerRule('agent-a', { mode: 'muted', follow: true }) })
    expect(bell.ruleOf('agent-a')).toEqual({ mode: 'muted', follow: true })
    await act(async () => { bell.setCoworkerRule('agent-a', { ...bell.ruleOf('agent-a'), mode: 'everything' }) })
    expect(settings.ruleOf('agent-a')).toEqual({ mode: 'everything', follow: true })
    expect(stored.coworkers['agent-a']).toEqual({ mode: 'everything', follow: true })
})

test('a late settings read cannot overwrite a newer saved bell choice', async () => {
    await mount()
    let finish!: (response: Response) => void
    const previous = fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => init?.method === 'PUT' ? previous(url, init) : new Promise<Response>(resolve => { finish = resolve })))
    let refresh!: Promise<void>
    await act(async () => { refresh = hook.refresh() })
    await act(async () => { hook.update({ scope: 'nothing' }) })
    await act(async () => { finish(Response.json({ ...stored, scope: 'everything' })); await refresh })
    expect(hook.prefs.scope).toBe('nothing')
})

test('a failed queued write retains the later pending optimistic patch', async () => {
    await mount()
    const pending: ((response: Response) => void)[] = []
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method !== 'PUT') return Promise.resolve(Response.json(stored))
        return new Promise<Response>(resolve => { pending.push(resolve) })
    }))
    await act(async () => { hook.update({ scope: 'nothing' }); hook.update({ sound: false }) })
    expect(pending).toHaveLength(1)
    await act(async () => { pending[0](Response.json({ error: 'failed' }, { status: 503 })) })
    expect(pending).toHaveLength(2)
    expect(hook.prefs.scope).toBe('everything')
    expect(hook.prefs.sound).toBe(false)
    await act(async () => { pending[1](Response.json({ ...stored, sound: false })) })
    expect(hook.prefs.sound).toBe(false)
})
