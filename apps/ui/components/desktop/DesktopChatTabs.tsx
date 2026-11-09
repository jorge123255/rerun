'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { OpenChatsTabStrip } from '@/components/agent/sheet/OpenChatsTabStrip'
import { CloseRunningTabDialog } from '@/components/dialogs/CloseRunningTabDialog'
import { Button } from '@/components/ui/button'
import { MAX_REMEMBERED_TABS, closeSessionTab, newSessionTab, openSessionTab, type SessionTabsState } from '@/lib/chat/session-tabs'
import { adoptGeneralId, ensureDesktopGeneralTab, isGeneralTab } from '@/lib/desktop/general-threads'
import type { DesktopTabLayout } from '@/lib/desktop/session-tabs'
import type { DesktopChatRequest } from '@/lib/desktop/chat-request'
import type { DesktopCoworkerPanelRequest } from '@/lib/desktop/coworker-panel-request'
import { queueTabWrite } from '@/lib/desktop/tab-writes'
import { forgetDesktopDraft, isDesktopQuitting } from '@/lib/desktop/draft-writes'
import type { DesktopAgentView, DesktopSessionView } from './DesktopApp'
import { DesktopChatHistory } from './DesktopChatHistory'
import type { DesktopConversationOverviewAuthority } from './coworker-overview/conversation-mount'
import { DesktopConversation, type ComposerDraft, type TabActivity } from './DesktopConversation'
import { DesktopRunHistory } from './DesktopRunHistory'

type Props = {
    agent: DesktopAgentView
    sessions: DesktopSessionView[]
    initialLayout: DesktopTabLayout | null
    requested: DesktopChatRequest | null
    requestedPanel?: DesktopCoworkerPanelRequest | null
    onPanelRequestHandled?: (request: DesktopCoworkerPanelRequest) => void
    selected: boolean
    onVisibleSession?: (agentId: string, sessionId: string | null) => void
    refreshSessions: () => Promise<void>
    reload: () => void
    onOpenCoworkerChat?: (target: { agentId: string; sessionId: string }) => Promise<void>
    onClosePanel: () => void
    onOpenModelSettings: () => void
    modelLabel?: string
    overview?: DesktopConversationOverviewAuthority
}

function initialTabs(agentId: string, layout: DesktopTabLayout | null, sessions: DesktopSessionView[], requested: DesktopChatRequest | null): SessionTabsState {
    const generalId = sessions.find(session => session.agentId === agentId && session.kind === 'general')?.id ?? null
    const stored = layout ?? (sessions[0] ? { tabs: [newSessionTab(sessions[0].id, sessions[0].title)], activeIndex: 0 } : { tabs: [], activeIndex: 0 })
    const pinned = ensureDesktopGeneralTab(agentId, stored.tabs.length ? stored : { tabs: [], activeIndex: 0 }, generalId)
    if (requested && 'tabUid' in requested) {
        const index = pinned.tabs.findIndex(tab => tab.uid === requested.tabUid && tab.id === requested.sessionId)
        if (index >= 0) return index === pinned.activeIndex ? pinned : { ...pinned, activeIndex: index }
    }
    const id = requested && 'id' in requested ? requested.id : undefined
    const session = id ? sessions.find(item => item.id === id) : undefined
    if (id && session?.kind === 'general') return { ...adoptGeneralId(pinned, id), activeIndex: 0 }
    return id && session ? openSessionTab(pinned, id, session.title) : pinned
}

export function DesktopChatTabs({ agent, sessions, initialLayout, requested, requestedPanel, onPanelRequestHandled, selected, onVisibleSession, refreshSessions, reload, onOpenCoworkerChat, onClosePanel, modelLabel, onOpenModelSettings, overview }: Props) {
    const [layout, setLayout] = useState(() => initialTabs(agent.id, initialLayout, sessions, requested))
    const [rejectedRequest, setRejectedRequest] = useState<DesktopChatRequest | null>(() => {
        const pinned = initialTabs(agent.id, initialLayout, sessions, requested)
        return requested && 'tabUid' in requested && !pinned.tabs.some(tab => tab.uid === requested.tabUid && tab.id === requested.sessionId) ? requested : null
    })
    const [canMountChats, setCanMountChats] = useState(!rejectedRequest)
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
        if (!rejectedRequest && initialLayout !== current.current) save(current.current)
    }, [initialLayout, save])

    const protectedUids = useCallback(() => new Set(current.current.tabs.filter(t => !t.id || !activityRef.current[t.uid] || activityRef.current[t.uid]?.busy || activityRef.current[t.uid]?.dirty).map(t => t.uid)), [])
    const open = useCallback((id: string | null, title: string) => {
        if (isDesktopQuitting()) return
        const previous = current.current
        const general = id ? sessions.find(session => session.id === id && session.agentId === agent.id && session.kind === 'general') : undefined
        if (id && (general || previous.tabs.some(tab => isGeneralTab(tab) && tab.id === id))) {
            const adopted = adoptGeneralId(ensureDesktopGeneralTab(agent.id, previous, id), id)
            void change({ tabs: adopted.tabs, activeIndex: 0 })
            return
        }
        if (pendingForks.current.size && previous.tabs.filter(tab => !isGeneralTab(tab)).length + pendingForks.current.size >= MAX_REMEMBERED_TABS && !previous.tabs.some(t => t.id === id)) {
            setNotice('Close an idle tab to open another conversation.')
            return
        }
        const next = openSessionTab(previous, id, title, protectedUids())
        setNotice(next === previous && !previous.tabs.some(tab => tab.id === id) ? 'Close an idle tab to open another conversation.' : '')
        change(next)
    }, [agent.id, change, protectedUids, sessions])

    useLayoutEffect(() => {
        if (lastRequest.current === requested) return
        lastRequest.current = requested
        if (!requested) {
            setRejectedRequest(null)
            if (!canMountChats) { setCanMountChats(true); void save(current.current) }
            return
        }
        if ('tabUid' in requested) {
            const index = current.current.tabs.findIndex(tab => tab.uid === requested.tabUid && tab.id === requested.sessionId)
            if (index < 0) { setRejectedRequest(requested); return }
            setRejectedRequest(null)
            setCanMountChats(true)
            if (!isDesktopQuitting() && index !== current.current.activeIndex) void change({ ...current.current, activeIndex: index })
            return
        }
        setRejectedRequest(null)
        setCanMountChats(true)
        const target = sessions.find(s => s.id === requested.id)
        if (target) open(target.id, target.title)
    }, [requested, sessions, open, change, canMountChats, save])

    const report = useCallback((uid: string, info: TabActivity) => {
        const old = activityRef.current[uid]
        if (old?.busy === info.busy && old?.dirty === info.dirty && old?.readableSessionId === info.readableSessionId) return
        activityRef.current = { ...activityRef.current, [uid]: info }
        setActivity(activityRef.current)
    }, [])

    const readableSession = selected && canMountChats && !rejectedRequest && active.id && activity[active.uid]?.readableSessionId === active.id ? active.id : null
    useEffect(() => {
        onVisibleSession?.(agent.id, readableSession)
        return () => onVisibleSession?.(agent.id, null)
    }, [agent.id, readableSession, onVisibleSession])

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
        if (activityRef.current[uid]?.recordingPending) { setNotice('Send or discard this recording before closing its tab.'); setPendingClose(null); return }
        const state = current.current
        const index = state.tabs.findIndex(tab => tab.uid === uid)
        if (index >= 0) change(closeSessionTab(state, index))
        setPendingClose(null)
    }

    function requestClose(index: number) {
        if (isDesktopQuitting()) return
        const tab = current.current.tabs[index]
        if (!tab || isGeneralTab(tab)) return
        if (activityRef.current[tab.uid]?.recordingPending) { setNotice('Send or discard this recording before closing its tab.'); return }
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
        if (current.current.tabs.filter(tab => !isGeneralTab(tab)).length + pendingForks.current.size >= MAX_REMEMBERED_TABS) {
            setNotice('Close a tab to open an alternate conversation.')
            return false
        }
        pendingForks.current.add(uid)
        setNotice('')
        return true
    }

    useEffect(() => {
        const general = sessions.find(session => session.agentId === agent.id && session.kind === 'general')
        if (!general) return
        const adopted = adoptGeneralId(ensureDesktopGeneralTab(agent.id, current.current, general.id), general.id)
        if (adopted.tabs === current.current.tabs && adopted.activeIndex === current.current.activeIndex) return
        void change(adopted)
    }, [agent.id, change, sessions])

    const displayTabs = layout.tabs.map(tab => ({ ...tab, title: isGeneralTab(tab) ? 'General' : sessions.find(s => s.id === tab.id)?.title ?? tab.title }))
    const strip = <OpenChatsTabStrip tabs={displayTabs} activeIndex={layout.activeIndex} newLabel="New thread"
        stateOf={tab => activity[tab.uid]?.busy ? 'live' : 'quiet'}
        onSelect={index => { if (!isDesktopQuitting() && index !== current.current.activeIndex) change({ ...current.current, activeIndex: index }) }}
        onClose={requestClose} onCreate={() => open(null, 'New conversation')} />
    return <>
        {rejectedRequest && <div role="alert" className="flex flex-wrap items-center gap-2 px-5 py-2 text-sm text-destructive">
            This open chat has changed or closed. Choose it again from Control center.
            <Button type="button" size="sm" variant="outline" onClick={reload}>Reload open chats</Button>
            <Button type="button" size="sm" variant="ghost" onClick={onClosePanel}>Close panel</Button>
        </div>}
        {(saveError || notice) && <div role="alert" className="flex items-center gap-2 px-3 py-1 text-xs text-destructive">
            {saveError?.message || notice}
            {saveError && <Button type="button" size="sm" variant="outline" onClick={() => saveError.conflict ? reload() : save(current.current)}>
                {saveError.conflict ? 'Reload open tabs' : 'Retry saving tabs'}
            </Button>}
        </div>}
        {canMountChats && layout.tabs.map(tab => {
            const visible = !rejectedRequest && active.uid === tab.uid
            if (!visible && !visited.includes(tab.uid)) return null
            return <div key={tab.uid} data-desktop-tab-active={visible} hidden={!visible} className={visible ? 'flex h-full min-h-0 flex-col' : 'hidden'}>
                <DesktopConversation overview={overview} agent={agent} sessionId={tab.id} sessions={sessions} tabUid={tab.uid} active={selected && visible}
                    requestedPanel={selected && visible ? requestedPanel : null} onPanelRequestHandled={onPanelRequestHandled}
                    tabStrip={visible ? strip : false} onTabActivity={report} initialDraft={drafts[tab.uid]} onStartFork={startFork} onFinishFork={uid => pendingForks.current.delete(uid)}
                    onSelectSession={(id, title) => {
                        open(id, title ?? sessions.find(s => s.id === id)?.title ?? 'New conversation')
                        if (id && !sessions.some(session => session.id === id)) void refreshSessions().catch(() => setNotice('Chat opened. Could not refresh the chat list. Reopen the coworker to retry.'))
                    }}
                    onChatSession={(id, sourceDraft) => bindSession(tab.uid, id, sourceDraft)}
                    onOpenCoworkerChat={onOpenCoworkerChat}
                    modelLabel={modelLabel} onOpenModelSettings={onOpenModelSettings} onClosePanel={onClosePanel}
                    renderHistory={(_busy, control) => <DesktopChatHistory control={control} agentId={agent.id} count={sessions.length} selectedId={tab.id} busy={false} onSelect={id => open(id, sessions.find(s => s.id === id)?.title ?? 'Conversation')} />}
                    renderRunHistory={control => <DesktopRunHistory agent={agent} dialogControl={control} />} />
            </div>
        })}
        <CloseRunningTabDialog open={pendingClose !== null} onOpenChange={value => { if (!value) setPendingClose(null) }}
            onConfirm={() => { if (pendingClose) close(pendingClose) }} />
    </>
}
