export const GENERAL_SESSION_TITLE = 'General'
export const NEW_THREAD_TITLE = 'New conversation'
export const FIRST_MESSAGE_MAX_CHARS = 300
export const GENERAL_ALREADY_OPEN = 'General is already open. Your draft was kept.'

export type DesktopSessionKind = 'general' | 'thread'

export type DesktopGeneralTab = {
    uid: string
    id: string | null
    title: string
    kind?: 'general'
}

export function generalTabUid(agentId: string): string {
    return `general:${agentId}`
}

export function isGeneralTab(tab: { uid?: string; kind?: string } | null | undefined): boolean {
    return tab?.kind === 'general' || !!tab?.uid?.startsWith('general:')
}

export function isGeneralTabFor(agentId: string, tab: { uid?: string; kind?: string } | null | undefined): boolean {
    return tab?.uid === generalTabUid(agentId)
}

export function openingMessage(text: string | null | undefined): string | null {
    const trimmed = text?.trim()
    if (!trimmed) return null
    return trimmed.slice(0, FIRST_MESSAGE_MAX_CHARS)
}

// Rows saved before this column have no kind. They stay threads, with their titles and content,
// until a person sends the first message in General.
export function kindOfStoredSession(kind: unknown): DesktopSessionKind {
    return kind === 'general' ? 'general' : 'thread'
}

export function ensureDesktopGeneralTab<T extends DesktopGeneralTab>(agentId: string, state: { tabs: T[]; activeIndex: number }, generalSessionId: string | null): { tabs: Array<T | DesktopGeneralTab>; activeIndex: number } {
    const uid = generalTabUid(agentId)
    const already = state.tabs.some(tab => isGeneralTab(tab))
    const general: DesktopGeneralTab = { uid, id: generalSessionId, title: GENERAL_SESSION_TITLE, kind: 'general' }
    const rest = state.tabs.filter(tab => !isGeneralTab(tab) && (generalSessionId === null || tab.id !== generalSessionId))
    const tabs = [general, ...rest]
    const active = state.tabs[state.activeIndex]
    const activeIndex = !active || isGeneralTab(active) || (generalSessionId !== null && active.id === generalSessionId)
        ? 0
        : tabs.findIndex(tab => tab.uid === active.uid)
    const resolved = activeIndex >= 0 ? activeIndex : already ? 0 : Math.min(tabs.length - 1, state.activeIndex + 1)
    const unchanged = state.activeIndex === resolved && state.tabs.length === tabs.length && state.tabs.every((tab, index) => tab === tabs[index] || (tab.uid === tabs[index]?.uid && tab.id === tabs[index]?.id && tab.kind === tabs[index]?.kind && tab.title === tabs[index]?.title))
    return unchanged ? state : { tabs, activeIndex: resolved }
}

export function adoptGeneralId<T extends DesktopGeneralTab>(state: { tabs: T[]; activeIndex: number }, sessionId: string): { tabs: T[]; activeIndex: number } {
    const general = state.tabs[0]
    if (!general || !isGeneralTab(general)) return state
    const duplicates = state.tabs.flatMap((tab, index) => index > 0 && tab.id === sessionId ? [index] : [])
    if (general.id === sessionId && duplicates.length === 0) return state
    const tabs = [{ ...general, id: sessionId }, ...state.tabs.filter((_, index) => index > 0 && !duplicates.includes(index))]
    const activeIndex = duplicates.includes(state.activeIndex) ? 0 : state.activeIndex - duplicates.filter(index => index < state.activeIndex).length
    return { tabs, activeIndex }
}

export function threadOpener(thread: { firstMessage?: string | null; source?: string | null; title: string; automationName?: string | null }, originName: string | null): { text: string; generic: boolean } {
    const firstMessage = thread.firstMessage?.trim()
    if (firstMessage) return { text: firstMessage, generic: false }
    if (thread.source === 'schedule') return { text: `Scheduled run · ${thread.automationName ?? thread.title}`, generic: true }
    if (thread.source === 'trigger') return { text: `Webhook · ${thread.automationName ?? thread.title}`, generic: true }
    if (thread.source === 'agent' || thread.source === 'delegate') return { text: `Asked by ${originName ?? 'another coworker'}`, generic: true }
    return { text: 'Started a thread', generic: true }
}
