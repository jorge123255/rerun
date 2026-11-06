export type DesktopFindAction = 'start' | 'next' | 'previous' | 'stop'

export type DesktopFindResult = { ok: boolean; matches?: number; activeMatchOrdinal?: number; stopped?: boolean; reason?: string }

type FindBridge = { findInPage?: (input: { action: DesktopFindAction; query?: string }) => Promise<DesktopFindResult> }

export async function desktopFindInPage(action: DesktopFindAction, query = ''): Promise<DesktopFindResult> {
    const bridge = (window as Window & { desktopApp?: FindBridge }).desktopApp?.findInPage
    if (!bridge) return { ok: false, reason: 'unavailable' }
    try {
        return await bridge({ action, query })
    } catch {
        return { ok: false, reason: 'unavailable' }
    }
}
