'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { OpenChatsTabStrip } from '@/components/agent/sheet/OpenChatsTabStrip'
import { CloseRunningTabDialog } from '@/components/dialogs/CloseRunningTabDialog'
import { Button } from '@/components/ui/button'
import { MAX_REMEMBERED_TABS, closeSessionTab, newSessionTab, openSessionTab, type SessionTabsState } from '@/lib/chat/session-tabs'
import type { DesktopTabLayout } from '@/lib/desktop/session-tabs'
import { queueTabWrite } from '@/lib/desktop/tab-writes'
import { forgetDesktopDraft, isDesktopQuitting } from '@/lib/desktop/draft-writes'
import type { DesktopAgentView, DesktopSessionView } from './DesktopApp'
import { DesktopChatHistory } from './DesktopChatHistory'
import { DesktopConversation, type ComposerDraft, type TabActivity } from './DesktopConversation'
import { DesktopRunHistory } from './DesktopRunHistory'

type Props = {
    agent: DesktopAgentView
    sessions: DesktopSessionView[]
    initialLayout: DesktopTabLayout | null
    requested: { id: string } | null
    selected: boolean
    refreshSessions: () => Promise<void>
    reload: () => void
    onClosePanel: () => void
    onOpenModelSettings: () => void
    modelLabel?: string
}

function initialTabs(layout: DesktopTabLayout | null, sessions: DesktopSessionView[], id?: string): SessionTabsState {
    const session = (id && sessions.find(s => s.id === id)) || sessions[0]
    const initial = layout ?? { tabs: [newSessionTab(session?.id ?? null, session?.title)], activeIndex: 0 }
    return id && session?.id === id ? openSessionTab(initial, id, session.title) : initial
}

export function DesktopChatTabs({ agent, sessions, initialLayout, requested, selected, refreshSessions, reload, onClosePanel, modelLabel, onOpenModelSettings }: Props) {
    const [layout, setLayout] = useState(() => initialTabs(initialLayout, sessions, requested?.id))
    const current = useRef(layout)
    const revision = useRef(initialLayout?.revision ?? 0)
    const conflicted = useRef(false)
    const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null)
    const [notice, setNotice] = useState('')
    const [pendingClose, setPendingClose] = useState<string | null>(null)
    const [activity, setActivity] = useState<Record<string, TabActivity>>({})
    const activityRef = useRef(activity)
    const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({})
    const pendingForks = useRef(new Set<string>())
    const active = layout.tabs[layout.activeIndex]
    const [visited, setVisited] = useState<string[]>([active.uid])
    const lastRequest = useRef(requested)
    const save = useCallback((next: SessionTabsState): Promise<boolean> => {
        return queueTabWrite(agent.id, async () => {
            if (conflicted.current) return false
            try {
                const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agent.id)}/tabs`, {
                    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
                        baseRevision: revision.current, activeIndex: next.activeIndex, tabs: next.tabs.map(({ uid, id }) => ({ uid, id })),
                    }),
                })
                const body = await response.json()
                if (!response.ok) {
                    if (response.status === 409) conflicted.current = true
                    throw new Error(body.error || 'Could not save the open conversations.')
                }
                if (!Number.isSafeInteger(body?.tabs?.revision) || body.tabs.revision < revision.current) throw new Error('Could not confirm the saved conversations. Try again.')
                revision.current = body.tabs.revision
                setSaveError(null)
                return true
            } catch (error) {
                setSaveError({ message: error instanceof Error ? error.message : 'Could not save the open conversations.', conflict: conflicted.current })
                return false
            }
        })
    }, [agent.id])

    const change = useCallback(async (next: SessionTabsState): Promise<boolean> => {
        if (next === current.current) return true
        const previous = current.current
        current.current = next
        setLayout(next)
        const saved = await save(next)
        // A failed layout write must not discard drafts that still belong to the saved tabs.
        if (saved) for (const old of previous.tabs) if (!current.current.tabs.some(tab => tab.uid === old.uid)) forgetDesktopDraft(agent.id, old.uid)
        return saved
    }, [agent.id, save])

    // A directly requested conversation starts active without loading an unrelated newer chat.
    useLayoutEffect(() => {
        if (initialLayout !== current.current) save(current.current)
    }, [initialLayout, save])

    const protectedUids = useCallback(() => new Set(current.current.tabs.filter(t => !t.id || !activityRef.current[t.uid] || activityRef.current[t.uid]?.busy || activityRef.current[t.uid]?.dirty).map(t => t.uid)), [])
    const open = useCallback((id: string | null, title: string) => {
        if (isDesktopQuitting()) return
        const previous = current.current
        if (pendingForks.current.size && previous.tabs.length + pendingForks.current.size >= MAX_REMEMBERED_TABS && !previous.tabs.some(t => t.id === id)) {
            setNotice('Close an idle tab to open another conversation.')
            return
        }
        const next = openSessionTab(previous, id, title, protectedUids())
        setNotice(next === previous && !previous.tabs.some(tab => tab.id === id) ? 'Close an idle tab to open another conversation.' : '')
        change(next)
    }, [change, protectedUids])

    useLayoutEffect(() => {
        if (!requested || lastRequest.current === requested) return
        lastRequest.current = requested
        const target = sessions.find(s => s.id === requested.id)
        if (target) open(target.id, target.title)
    }, [requested, sessions, open])

    const report = useCallback((uid: string, info: TabActivity) => {
        const old = activityRef.current[uid]
        if (old?.busy === info.busy && old?.dirty === info.dirty) return
        activityRef.current = { ...activityRef.current, [uid]: info }
        setActivity(activityRef.current)
    }, [])

    // As in AgentPanelChat, keep recent tabs mounted and always keep a tab that owns a stream
    // or an unsent draft. Evicted idle tabs fetch their own saved transcript on next selection.
    useEffect(() => {
        const live = new Set(layout.tabs.map(t => t.uid))
        setDrafts(older => Object.keys(older).every(uid => live.has(uid)) ? older : Object.fromEntries(Object.entries(older).filter(([uid]) => live.has(uid))))
        const known = activityRef.current
        if (!Object.keys(known).every(uid => live.has(uid))) {
            activityRef.current = Object.fromEntries(Object.entries(known).filter(([uid]) => live.has(uid)))
            setActivity(activityRef.current)
        }
        setVisited(older => {
            const kept = [...older.filter(uid => uid !== active.uid && live.has(uid)), active.uid]
            for (let i = 0; kept.length > 3 && i < kept.length - 1;) {
                const state = activityRef.current[kept[i]]
                if (state?.busy || state?.dirty || layout.tabs.find(t => t.uid === kept[i])?.id === null) i++
                else kept.splice(i, 1)
            }
            return kept.length === older.length && kept.every((uid, i) => uid === older[i]) ? older : kept
        })
    }, [active.uid, layout.tabs])

    function close(uid: string) {
        const state = current.current
        const index = state.tabs.findIndex(tab => tab.uid === uid)
        if (index >= 0) change(closeSessionTab(state, index))
        setPendingClose(null)
    }

    function requestClose(index: number) {
        if (isDesktopQuitting()) return
        const tab = current.current.tabs[index]
        if (!tab) return
        if (activityRef.current[tab.uid]?.busy) {
            if (tab.id) setPendingClose(tab.uid)
            else setNotice('This conversation is starting. You can switch tabs and close it once the first message is accepted.')
        } else close(tab.uid)
    }

    useEffect(() => {
        if (!selected) return
        function shortcut(event: KeyboardEvent) {
            if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || document.querySelector('[role="dialog"],[role="alertdialog"]')) return
            if (event.key.toLowerCase() === 'k') { event.preventDefault(); open(null, 'New conversation') }
            if (event.key === 'Backspace' && !(event.target as HTMLElement)?.closest('input,textarea,[contenteditable="true"]')) {
                event.preventDefault()
                requestClose(current.current.activeIndex)
            }
        }
        document.addEventListener('keydown', shortcut)
        return () => document.removeEventListener('keydown', shortcut)
    })

    const bindSession = useCallback(async (uid: string, id: string, sourceDraft?: ComposerDraft): Promise<boolean> => {
        const previous = current.current
        const source = previous.tabs.find(t => t.uid === uid)
        if (!source) { void refreshSessions(); return false }
        if (source.id !== id) {
            setNotice('')
            let tabs = previous.tabs.map(tab => tab.uid === uid ? { ...tab, id } : tab)
            let activeUid = previous.tabs[previous.activeIndex].uid
            if (source.id && sourceDraft) {
                // Keep the live stream on its uid while the original gets its own tab and draft.
                const original = newSessionTab(source.id, source.title)
                setDrafts(older => ({ ...older, [original.uid]: sourceDraft }))
                tabs = tabs.flatMap(t => t.uid === uid ? [original, { ...t, title: `Alternate · ${source.title}` }] : t.id === id ? [] : [t])
                if (!tabs.some(t => t.uid === activeUid)) activeUid = uid

            }
            // A saved chat can be opened from history before its delayed first-send headers arrive.
            tabs = tabs.filter(t => t.uid === uid || t.id !== id)
            if (!tabs.some(t => t.uid === activeUid)) activeUid = uid
            const next = { tabs, activeIndex: tabs.findIndex(t => t.uid === activeUid) }
            const saved = await change(next)
            if (!saved) {
                // Only undo this optimistic fork. A subsequent user selection or layout change
                // owns the current view and must not be replaced by this older callback.
                if (source.id && sourceDraft && current.current === next) {
                    current.current = previous
                    setLayout(previous)
                }
                void refreshSessions()
                return false
            }
        }
        void refreshSessions()
        return true
    }, [change, refreshSessions])

    function startFork(uid: string) {
        if (current.current.tabs.length + pendingForks.current.size >= MAX_REMEMBERED_TABS) {
            setNotice('Close a tab to open an alternate conversation.')
            return false
        }
        pendingForks.current.add(uid)
        setNotice('')
        return true
    }

    const displayTabs = layout.tabs.map(tab => ({ ...tab, title: sessions.find(s => s.id === tab.id)?.title ?? tab.title }))
    const strip = <OpenChatsTabStrip tabs={displayTabs} activeIndex={layout.activeIndex} newLabel="New chat"
        stateOf={tab => activity[tab.uid]?.busy ? 'live' : 'quiet'}
        onSelect={index => { if (!isDesktopQuitting() && index !== current.current.activeIndex) change({ ...current.current, activeIndex: index }) }}
        onClose={requestClose} onCreate={() => open(null, 'New conversation')} />
    return <>
        {(saveError || notice) && <div role="alert" className="flex items-center gap-2 px-3 py-1 text-xs text-destructive">
            {saveError?.message || notice}
            {saveError && <Button type="button" size="sm" variant="outline" onClick={() => saveError.conflict ? reload() : save(current.current)}>
                {saveError.conflict ? 'Reload open tabs' : 'Retry saving tabs'}
            </Button>}
        </div>}
        {layout.tabs.map(tab => {
            const visible = active.uid === tab.uid
            if (!visible && !visited.includes(tab.uid)) return null
            return <div key={tab.uid} data-desktop-tab-active={visible} hidden={!visible} className={visible ? 'flex h-full min-h-0 flex-col' : 'hidden'}>
                <DesktopConversation agent={agent} sessionId={tab.id} sessions={sessions} tabUid={tab.uid} active={selected && visible}
                    tabStrip={visible ? strip : false} onTabActivity={report} initialDraft={drafts[tab.uid]} onStartFork={startFork} onFinishFork={uid => pendingForks.current.delete(uid)}
                    onSelectSession={id => open(id, sessions.find(s => s.id === id)?.title ?? 'New conversation')}
                    onChatSession={(id, sourceDraft) => bindSession(tab.uid, id, sourceDraft)}
                    modelLabel={modelLabel} onOpenModelSettings={onOpenModelSettings} onClosePanel={onClosePanel}
                    renderHistory={() => <DesktopChatHistory agentId={agent.id} count={sessions.length} selectedId={tab.id} busy={false} onSelect={id => open(id, sessions.find(s => s.id === id)?.title ?? 'Conversation')} />}
                    renderRunHistory={<DesktopRunHistory agent={agent} />} />
            </div>
        })}
        <CloseRunningTabDialog open={pendingClose !== null} onOpenChange={value => { if (!value) setPendingClose(null) }}
            onConfirm={() => { if (pendingClose) close(pendingClose) }} />
    </>
}
