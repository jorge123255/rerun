// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest'
import type { DesktopNotificationAdmission } from './notifications'
import { showDesktopNotificationToast } from './notification-toast'

const custom = vi.fn(), dismiss = vi.fn(), resolveClick = vi.fn()
vi.mock('sonner', () => ({ toast: { custom: (...args: unknown[]) => custom(...args), dismiss: (...args: unknown[]) => dismiss(...args) } }))
vi.mock('@/lib/desktop/notification-click', () => ({ resolveDesktopNotificationClick: (...args: unknown[]) => resolveClick(...args) }))
vi.mock('@/components/notifications/NotificationToast', () => ({
    NotificationToast: (props: Record<string, unknown>) => <div data-testid="card">{String(props.title)}|{String(props.message)}</div>,
}))

beforeEach(() => { custom.mockClear(); dismiss.mockClear(); resolveClick.mockReset() })

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

test('open revalidates the exact target before navigating and dismisses first', async () => {
    const navigate = vi.fn()
    showDesktopNotificationToast(event(), navigate)
    resolveClick.mockResolvedValue({ agentId: 'agent-a', sessionId: 'chat-a' })
    ;(rendered().props.onOpen as () => void)()
    expect(dismiss).toHaveBeenCalledWith('toast-1')
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ agentId: 'agent-a', sessionId: 'chat-a' }))
    expect(resolveClick).toHaveBeenCalledWith(expect.objectContaining({ kind: 'question', agentId: 'agent-a', sessionId: 'chat-a', requestId: 'request-a' }), expect.any(AbortSignal))
})

test('a failed revalidation navigates nowhere', async () => {
    const navigate = vi.fn()
    showDesktopNotificationToast(event(), navigate)
    resolveClick.mockResolvedValue(null)
    ;(rendered().props.onOpen as () => void)()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(navigate).not.toHaveBeenCalled()
})
