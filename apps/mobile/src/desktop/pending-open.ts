// What a screen is opened for, handed over in memory by the page that opens it: the coworker's name,
// and for a takeover the call to answer and the page to open. Left to a route parameter, any link the
// phone opens could drive the coworker's browser to a page of its choosing.
export type DesktopOpen = { agentId: string; name: string; call?: string; url?: string }

let pending: DesktopOpen | null = null

export function setPendingDesktopOpen(open: DesktopOpen) {
    pending = open
}

export function takePendingDesktopOpen(agentId: string): DesktopOpen | null {
    const open = pending?.agentId === agentId ? pending : null
    pending = null
    return open
}
