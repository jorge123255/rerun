import { DESKTOP_OPENCODE_USAGE_STALE_MS, DESKTOP_OPENCODE_USAGE_URL, desktopOpencodeWindows, type DesktopOpencodeWindow } from '@rerun/contracts'

// A usage read never marks the key refused. Only an inference 401 does that.
// Nothing here reads process.env.

const READ_TIMEOUT_MS = 8_000
type Reading = { windows: DesktopOpencodeWindow[]; capturedAt: string }
const readings = new Map<string, Reading>()
const attemptedAt = new Map<string, number>()
const inFlight = new Map<string, Promise<DesktopOpencodeWindow[] | null>>()

const keyOf = (workspaceId: number, connectionId: string) => `${workspaceId}:${connectionId}`

export function resetDesktopOpencodeLimitsForTests(): void {
    readings.clear()
    attemptedAt.clear()
    inFlight.clear()
}

export function readDesktopOpencodeLimits(workspaceId: number, connectionId: string): Reading | null {
    return readings.get(keyOf(workspaceId, connectionId)) ?? null
}

export function forgetDesktopOpencodeLimits(workspaceId: number, connectionId: string): void {
    const name = keyOf(workspaceId, connectionId)
    readings.delete(name)
    attemptedAt.delete(name)
}

export function spentDesktopOpencodeWindow(workspaceId: number, connectionId: string): DesktopOpencodeWindow | null {
    return readings.get(keyOf(workspaceId, connectionId))?.windows.find(window => window.usedPercent >= 100) ?? null
}

export async function refreshDesktopOpencodeLimits(input: {
    workspaceId: number
    connectionId: string
    apiKey: string | null
    fetch: typeof fetch
    signal?: AbortSignal
    now?: number
    userAgent?: string
}): Promise<DesktopOpencodeWindow[] | null> {
    if (!input.apiKey) return null
    const name = keyOf(input.workspaceId, input.connectionId)
    const pending = inFlight.get(name)
    if (pending) return pending
    const now = input.now ?? Date.now()
    attemptedAt.set(name, now)
    const signal = input.signal ?? AbortSignal.timeout(READ_TIMEOUT_MS)
    const task = (async () => {
        if (signal.aborted) return readDesktopOpencodeLimits(input.workspaceId, input.connectionId)?.windows ?? null
        const response = await input.fetch(DESKTOP_OPENCODE_USAGE_URL, {
            headers: { Authorization: `Bearer ${input.apiKey}`, 'User-Agent': input.userAgent ?? 'rerun-desktop-opencode/1' },
            redirect: 'error',
            signal,
        })
        if (!response.ok) return null
        const windows = desktopOpencodeWindows(await response.json().catch(() => null))
        if (!windows.length) return null
        readings.set(name, { windows, capturedAt: new Date(now).toISOString() })
        return windows
    })().catch(() => null).finally(() => inFlight.delete(name))
    inFlight.set(name, task)
    return task
}

export function refreshStaleDesktopOpencodeLimits(input: Parameters<typeof refreshDesktopOpencodeLimits>[0]): Promise<DesktopOpencodeWindow[] | null> | null {
    const now = input.now ?? Date.now()
    const name = keyOf(input.workspaceId, input.connectionId)
    const pending = inFlight.get(name)
    if (pending) return pending
    if (now - (attemptedAt.get(name) ?? 0) < DESKTOP_OPENCODE_USAGE_STALE_MS) return null
    return refreshDesktopOpencodeLimits(input)
}
