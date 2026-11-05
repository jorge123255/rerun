// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LucideIcon } from '@/lib/icons'
import type { DesktopNotificationAdmission } from './notifications'
import { showDesktopNotificationToast } from './notification-toast'

const custom = vi.fn(), dismiss = vi.fn()
vi.mock('sonner', () => ({ toast: { custom: (...args: unknown[]) => custom(...args), dismiss: (...args: unknown[]) => dismiss(...args) } }))
vi.mock('@/components/notifications/NotificationToast', () => ({
    NotificationToast: (props: Record<string, unknown>) => <div data-testid="card">{String(props.title)}|{String(props.message)}</div>,
}))

beforeEach(() => { custom.mockClear(); dismiss.mockClear() })

const event = (over: Partial<DesktopNotificationAdmission> = {}): DesktopNotificationAdmission => ({
    key: 'pending:request-a', kind: 'question', source: 'chat', agentId: 'agent-a', agentName: 'Ada',
    sessionId: 'chat-a', title: 'Ada', subtitle: 'Question', body: 'Choose a color', silent: false,
    requestId: 'request-a', attemptId: '123e4567-e89b-42d3-a456-426614174000', ...over,
})

function rendered() {
    const render = custom.mock.calls.at(-1)![0] as (id: string) => { props: Record<string, unknown> }
    return render('toast-1')
}

test('a chat event toasts the original card copy keyed by the event', () => {
    showDesktopNotificationToast(event())
    expect(custom).toHaveBeenCalledWith(expect.any(Function), { id: 'desktop-notification:pending:request-a' })
    const card = rendered()
    expect(card.props.title).toBe('Ada')
    expect(card.props.message).toBe('Choose a color')
})

test('a scheduled event carries the scheduled badge copy and falls back to the subtitle', () => {
    showDesktopNotificationToast(event({ source: 'schedule', kind: 'done', body: null, subtitle: 'morning-digest · Done', requestId: undefined, groupId: 'group-a', silent: true }))
    const card = rendered()
    expect(card.props.title).toBe('Ada · Scheduled task')
    expect(card.props.message).toBe('morning-digest · Done')
})

test('open dismisses and hands the pinned target to the shared native/toast navigator', () => {
    const openTarget = vi.fn()
    showDesktopNotificationToast(event(), openTarget)
    ;(rendered().props.onOpen as () => void)()
    expect(dismiss).toHaveBeenCalledWith('toast-1')
    expect(openTarget).toHaveBeenCalledWith(expect.objectContaining({ key: 'pending:request-a', kind: 'question', agentId: 'agent-a', sessionId: 'chat-a', requestId: 'request-a' }))
})
test('browser takeover toast has a renderable icon and keeps its exact target', () => {
    const openTarget = vi.fn()
    showDesktopNotificationToast(event({ kind: 'takeover' }), openTarget)
    const card = rendered(), Icon = card.props.Icon as LucideIcon
    expect(renderToStaticMarkup(<Icon />)).toContain('<svg')
    expect(card.props.iconColor).toBe('text-cyan-400')
    ;(card.props.onOpen as () => void)()
    expect(openTarget).toHaveBeenCalledWith(expect.objectContaining({ kind: 'takeover', sessionId: 'chat-a', requestId: 'request-a' }))
})
