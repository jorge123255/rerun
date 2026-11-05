// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DEFAULT_COWORKER_RULE, DEFAULT_NOTIFICATION_PREFS, normalizeNotificationPrefs, type NotificationPrefs } from '@rerun/contracts'
import { DesktopTaskNotifyField } from './DesktopTaskNotifyField'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let prefs: NotificationPrefs = normalizeNotificationPrefs(undefined)
const update = vi.fn()

vi.mock('@/lib/desktop/use-notification-prefs', () => ({
    useDesktopNotificationPrefs: () => ({ prefs, update, setCoworkerRule: vi.fn(), ruleOf: () => DEFAULT_COWORKER_RULE, ready: true }),
}))

beforeEach(() => { update.mockReset(); prefs = normalizeNotificationPrefs({ ...DEFAULT_NOTIFICATION_PREFS, tasks: { 'agent-a:schedule:morning': true } }) })
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })

async function mount(slug = 'morning') {
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => { root?.render(<DesktopTaskNotifyField agentId="agent-a" source="schedule" slug={slug} />) })
    return container
}

test('reflects the exact task rule and writes only that task key', async () => {
    const container = await mount()
    const control = container.querySelector('[role="switch"]')!
    expect(control.getAttribute('aria-checked')).toBe('true')
    await act(async () => { control.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(update).toHaveBeenCalledWith({ tasks: { 'agent-a:schedule:morning': false } })
})

test('a muted coworker disables the switch', async () => {
    prefs = normalizeNotificationPrefs({ ...DEFAULT_NOTIFICATION_PREFS, coworkers: { 'agent-a': { mode: 'muted' } } })
    const container = await mount()
    expect(container.querySelector('[role="switch"]')!.hasAttribute('disabled')).toBe(true)
})

test('an unsaved task renders nothing', async () => {
    const container = await mount('')
    expect(container.querySelector('[role="switch"]')).toBeNull()
})
