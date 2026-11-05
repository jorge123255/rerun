// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DEFAULT_COWORKER_RULE, DEFAULT_NOTIFICATION_PREFS, normalizeNotificationPrefs, type CoworkerRule, type NotificationPrefs } from '@rerun/contracts'
import { DesktopCoworkerNotificationBell } from './DesktopCoworkerNotificationBell'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let prefs: NotificationPrefs = normalizeNotificationPrefs(undefined)
const setCoworkerRule = vi.fn(), update = vi.fn()
let menuProps: Record<string, unknown> = {}
let schedules: unknown[] = []

vi.mock('@/lib/desktop/use-notification-prefs', () => ({
    useDesktopNotificationPrefs: () => ({
        prefs,
        update,
        setCoworkerRule,
        ruleOf: (agentId: string | null | undefined) => prefs.coworkers[agentId ?? ''] ?? DEFAULT_COWORKER_RULE,
        ready: true,
    }),
}))
vi.mock('@/components/notifications/settings/CoworkerBellMenu', () => ({
    CoworkerBellMenu: (props: Record<string, unknown>) => {
        menuProps = props
        return <button type="button" data-testid="bell" onClick={() => (props.onOpenChange as (open: boolean) => void)?.(true)} />
    },
}))

beforeEach(() => {
    prefs = normalizeNotificationPrefs({ ...DEFAULT_NOTIFICATION_PREFS, scope: 'needed' })
    setCoworkerRule.mockReset(); update.mockReset(); menuProps = {}; schedules = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (String(url).includes('/schedules')) return Response.json(schedules)
        throw new Error(`Unexpected request ${url}`)
    }))
})

afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals()
})

async function mount(onOpenSettings = vi.fn()) {
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => { root?.render(<DesktopCoworkerNotificationBell agentId="agent-a" name="Ada" onOpenSettings={onOpenSettings} />) })
    return onOpenSettings
}

test('passes the stored rule, scope and lazy scheduled count into the original menu', async () => {
    prefs = normalizeNotificationPrefs({ ...DEFAULT_NOTIFICATION_PREFS, scope: 'needed', coworkers: { 'agent-a': { mode: 'everything', follow: true } } })
    schedules = [{ id: 's1' }, { id: 's2' }]
    await mount()
    expect(menuProps.rule).toEqual({ mode: 'everything', follow: true })
    expect(menuProps.scope).toBe('needed')
    expect(menuProps.scheduledCount).toBe(0)
    await act(async () => { (menuProps.onOpenChange as (open: boolean) => void)(true) })
    await act(async () => {})
    expect(menuProps.scheduledCount).toBe(2)
})

test('menu changes write the exact coworker rule and settings opens through the prop', async () => {
    const onOpenSettings = await mount()
    const rule: CoworkerRule = { mode: 'muted' }
    await act(async () => { (menuProps.onChange as (rule: CoworkerRule) => void)(rule) })
    expect(setCoworkerRule).toHaveBeenCalledWith('agent-a', rule)
    await act(async () => { (menuProps.onOpenSettings as () => void)() })
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
})

test('a Strict Mode remount can still read the current scheduled count', async () => {
    schedules = [{ slug: 'morning' }]
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => { root?.render(<StrictMode><DesktopCoworkerNotificationBell agentId="agent-a" name="Ada" onOpenSettings={() => {}} /></StrictMode>) })
    await act(async () => { (menuProps.onOpenChange as (open: boolean) => void)(true) })
    expect(menuProps.scheduledCount).toBe(1)
})

test('a former owner scheduled count cannot replace the new owner count', async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('agent-a') ? new Promise<Response>(resolve => { finish = resolve }) : Promise.resolve(Response.json([{ slug: 'bob-task' }]))))
    await mount()
    await act(async () => { (menuProps.onOpenChange as (open: boolean) => void)(true) })
    await act(async () => { root?.render(<DesktopCoworkerNotificationBell agentId="agent-b" name="Bob" onOpenSettings={() => {}} />) })
    await act(async () => { (menuProps.onOpenChange as (open: boolean) => void)(true) })
    await act(async () => { finish(Response.json([{ slug: 'a' }, { slug: 'b' }])) })
    expect(menuProps.scheduledCount).toBe(1)
})
