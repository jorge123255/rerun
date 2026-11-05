'use client'

// The narrow native-notification bridge the shell exposes. The blanket renderer-permission
// denial in the shell stays intact: the main process owns the OS notification, and the renderer
// only hands over a payload and hears back about clicks. Nothing here requests a permission.

export type DesktopNotificationCopy = { title: string; subtitle?: string; body?: string; silent?: boolean }

// The identity a click must revalidate before navigating: the finished-run group for a completion,
// the recorded terminal for a stopped or failed run, the exact pending request hash for a
// question or approval.
export type DesktopNotificationTarget = {
    key: string
    kind: 'done' | 'error' | 'question' | 'approval'
    agentId: string
    sessionId: string | null
    groupId?: string | null
    terminalId?: string | null
    requestId?: string | null
}

type DesktopNotificationsBridge = {
    notify?: (notification: DesktopNotificationCopy & DesktopNotificationTarget) => void
    onNotificationClick?: (handler: (target: DesktopNotificationTarget) => void) => () => void
}

export type DesktopNotificationsHandle = {
    available: boolean
    notify: (notification: DesktopNotificationCopy & DesktopNotificationTarget) => void
    onClick: (handler: (target: DesktopNotificationTarget) => void) => () => void
}

export function desktopNotificationsBridge(): DesktopNotificationsHandle {
    if (typeof window === 'undefined') return { available: false, notify: () => {}, onClick: () => () => {} }
    const bridge = (window as Window & { desktopApp?: { notifications?: DesktopNotificationsBridge } }).desktopApp?.notifications
    return {
        available: typeof bridge?.notify === 'function',
        notify: payload => { if (typeof bridge?.notify === 'function') bridge.notify(payload) },
        onClick: handler => (typeof bridge?.onNotificationClick === 'function' ? bridge.onNotificationClick(handler) : () => {}),
    }
}
