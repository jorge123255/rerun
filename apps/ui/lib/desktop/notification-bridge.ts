'use client'

// The narrow native-notification bridge the shell exposes. The blanket renderer-permission
// denial in the shell stays intact: the main process owns the OS notification, and the renderer
// only hands over a payload and hears back about clicks. Nothing here requests a permission.

export type DesktopNotificationCopy = { title: string; subtitle?: string; body?: string; silent?: boolean }
export type DesktopNotificationAcceptanceResult = { status: 'accepted' | 'unavailable' | 'failed' | 'unknown' }
export type DesktopNotificationDeliveryResult = DesktopNotificationAcceptanceResult
type DesktopNotificationBridgeResult = { status: DesktopNotificationAcceptanceResult['status'] | 'shown' }

// The identity a click must revalidate before navigating: the finished-run group for a completion,
// the recorded terminal for a failed run, the exact pending request hash for a
// question or approval.
export type DesktopNotificationTarget = {
    key: string
    kind: 'done' | 'error' | 'info' | 'question' | 'approval' | 'takeover' | 'service' | 'secret' | 'mcp' | 'tool-install'
    agentId: string
    sessionId: string | null
    groupId?: string | null
    terminalId?: string | null
    requestId?: string | null
}

type DesktopNotificationsBridge = {
    notify?: (notification: DesktopNotificationCopy & DesktopNotificationTarget) => Promise<DesktopNotificationBridgeResult>
    onNotificationClick?: (handler: (target: DesktopNotificationTarget) => void) => () => void
}

export type DesktopNotificationsHandle = {
    available: boolean
    notify: (notification: DesktopNotificationCopy & DesktopNotificationTarget) => Promise<DesktopNotificationDeliveryResult>
    onClick: (handler: (target: DesktopNotificationTarget) => void) => () => void
}

export function desktopNotificationsBridge(): DesktopNotificationsHandle {
    if (typeof window === 'undefined') return { available: false, notify: async () => ({ status: 'unavailable' }), onClick: () => () => {} }
    const bridge = (window as Window & { desktopApp?: { notifications?: DesktopNotificationsBridge } }).desktopApp?.notifications
    return {
        available: typeof bridge?.notify === 'function',
        notify: async payload => {
            if (typeof bridge?.notify !== 'function') return { status: 'unavailable' }
            try {
                const result = await bridge.notify(payload)
                if (result?.status === 'shown' || result?.status === 'accepted') return { status: 'accepted' }
                if (result?.status === 'unavailable' || result?.status === 'failed' || result?.status === 'unknown') return { status: result.status }
                return { status: 'unknown' }
            } catch { return { status: 'unknown' } }
        },
        onClick: handler => (typeof bridge?.onNotificationClick === 'function' ? bridge.onNotificationClick(handler) : () => {}),
    }
}
