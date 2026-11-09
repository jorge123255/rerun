import { nanoid } from 'nanoid'
import { isGeneralTab } from '@/lib/desktop/general-threads'

export type SessionTab = {
    uid: string
    id: string | null
    title: string
    kind?: 'general'
}

export type SessionTabsState = {
    tabs: SessionTab[]
    activeIndex: number
}

// The conversations opened in this panel, most recent last, each one a tab. Past this many the
// oldest are forgotten, and reopened from the coworker's chats list.
export const MAX_REMEMBERED_TABS = 8

// Keeps the newest tabs, and always the active one: a list saved under the old, higher ceiling can
// hold it among the oldest.
export function remember(state: SessionTabsState): SessionTabsState {
    const pinned = isGeneralTab(state.tabs[0]) ? state.tabs.slice(0, 1) : []
    const threads = state.tabs.slice(pinned.length)
    if (threads.length <= MAX_REMEMBERED_TABS) return state
    const active = state.tabs[state.activeIndex]
    const newest = threads.slice(-MAX_REMEMBERED_TABS)
    const kept = !active || isGeneralTab(active) || newest.includes(active) ? newest : [active, ...newest.slice(1)]
    const tabs = [...pinned, ...kept]
    return { tabs, activeIndex: Math.max(0, tabs.indexOf(active)) }
}

export function newSessionTab(id: string | null = null, title = 'New conversation'): SessionTab {
    return { uid: nanoid(), id, title }
}

// A conversation is open once, including the unsent new conversation. When the strip is full,
// allow the oldest idle tab to make room. A live run or an unsent draft can keep its tab.
export function openSessionTab(state: SessionTabsState, id: string | null, title: string, protectedUids?: ReadonlySet<string>): SessionTabsState {
    if (id === null) {
        const blank = state.tabs.findIndex(tab => tab.id === null && !isGeneralTab(tab))
        if (blank >= 0) return blank === state.activeIndex ? state : { ...state, activeIndex: blank }
    } else {
        const index = state.tabs.findIndex(tab => tab.id === id)
        if (index >= 0) return index === state.activeIndex ? state : { ...state, activeIndex: index }
    }
    let tabs = state.tabs
    if (tabs.filter(tab => !isGeneralTab(tab)).length >= MAX_REMEMBERED_TABS) {
        const oldest = tabs.findIndex(tab => !isGeneralTab(tab) && !protectedUids?.has(tab.uid))
        if (oldest < 0) return state
        tabs = tabs.filter((_, index) => index !== oldest)
    }
    return remember({ tabs: [...tabs, newSessionTab(id, title)], activeIndex: tabs.length })
}

export function closeSessionTab(state: SessionTabsState, index: number): SessionTabsState {
    if (isGeneralTab(state.tabs[index])) return state
    if (state.tabs.length === 1) return { tabs: [newSessionTab()], activeIndex: 0 }
    const tabs = state.tabs.filter((_, i) => i !== index)
    const activeIndex = index < state.activeIndex ? state.activeIndex - 1 : Math.min(state.activeIndex, tabs.length - 1)
    return { tabs, activeIndex: Math.max(0, activeIndex) }
}
