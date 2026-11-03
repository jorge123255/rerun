'use client'

import { nanoid } from 'nanoid'
import { useCallback, useEffect, useState } from 'react'

import { closeSessionTab, newSessionTab, openSessionTab, remember, type SessionTabsState } from '@/lib/chat/session-tabs'
export { MAX_REMEMBERED_TABS, remember } from '@/lib/chat/session-tabs'
export type { SessionTab, SessionTabsState } from '@/lib/chat/session-tabs'

function getStorageKey(agentId: string) {
    return `session-tabs-${agentId}`
}

function loadFromStorage(agentId: string): SessionTabsState | null {
    try {
        const raw = localStorage.getItem(getStorageKey(agentId))
        if (!raw) return null
        const parsed = JSON.parse(raw) as SessionTabsState
        if (!parsed?.tabs?.length) return null
        // Migration: anciens onglets stockés sans `uid` → en générer un. Le plafond a baissé
        // depuis que les onglets se voient : un état sauvé au-dessus est ramené dessous.
        return remember({
            ...parsed,
            tabs: parsed.tabs.map(t => (t.uid ? t : { ...t, uid: nanoid() })),
        })
    } catch {
        return null
    }
}

function saveToStorage(agentId: string, state: SessionTabsState) {
    try {
        localStorage.setItem(getStorageKey(agentId), JSON.stringify(state))
    } catch {}
}

export function useSessionTabs(agentId: string) {
    const [state, setState] = useState<SessionTabsState>(() => {
        const stored = loadFromStorage(agentId)
        return stored ?? { tabs: [newSessionTab()], activeIndex: 0 }
    })

    useEffect(() => {
        const stored = loadFromStorage(agentId)
        setState(stored ?? { tabs: [newSessionTab()], activeIndex: 0 })
    }, [agentId])

    useEffect(() => {
        saveToStorage(agentId, state)
    }, [agentId, state])

    const activeSessionId = state.tabs[state.activeIndex]?.id ?? null

    // A conversation nobody has spoken in yet is the new one: asking again lands on it.
    const createNew = useCallback(() => {
        setState(prev => openSessionTab(prev, null, 'New conversation'))
    }, [])

    const selectTab = useCallback((index: number) => {
        setState(prev => (index === prev.activeIndex ? prev : { ...prev, activeIndex: index }))
    }, [])

    const closeTab = useCallback((index: number) => {
        setState(prev => closeSessionTab(prev, index))
    }, [])

    const openTab = useCallback((sessionId: string, title: string) => {
        setState(prev => openSessionTab(prev, sessionId, title))
    }, [])

    const updateTabByUid = useCallback((uid: string, sessionId: string, title?: string) => {
        setState(prev => ({
            ...prev,
            tabs: prev.tabs.map(t => (t.uid === uid ? { ...t, id: sessionId, title: title ?? t.title } : t)),
        }))
    }, [])

    const updateTabTitle = useCallback((sessionId: string, title: string) => {
        setState(prev => ({
            ...prev,
            tabs: prev.tabs.map(t => (t.id === sessionId ? { ...t, title } : t)),
        }))
    }, [])

    return {
        tabs: state.tabs,
        activeIndex: state.activeIndex,
        activeSessionId,
        createNew,
        selectTab,
        closeTab,
        openTab,
        updateTabByUid,
        updateTabTitle,
    }
}
