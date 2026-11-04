'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import type { ThemePreference } from '@rerun/ui/theme'
import { connectionsListSchema, PROVIDER_LABELS, type ConnectionsList } from '@rerun/contracts'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import type { SettingsChange } from '@/lib/desktop/settings'
import { DesktopSettings } from './DesktopSettings'
import { ArrowLeft, X } from 'lucide-react'
import { SidePanel } from '@/components/layout/SidePanel'
import { SIDE_PANEL_GAP, loadSidePanelWidth } from '@/lib/side-panel-width'
import { DesktopWorkspaceMenu } from './DesktopWorkspaceMenu'
import { DesktopWorkspaceSettings } from './DesktopWorkspaceSettings'
import { DesktopSharedData } from './DesktopSharedData'
import { DesktopBoard } from './DesktopBoard'
import { useDesktopBoardState } from './useDesktopBoardState'
import type { DesktopBoardState } from '@/lib/desktop/spaces'
import { useBoardActivity } from './useBoardActivity'
import { DesktopControlCenter } from './DesktopControlCenter'
import { DesktopShortcutsDialog } from './DesktopShortcutsDialog'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import type { GridPosition } from '@rerun/ui/iso-grid'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DesktopChatTabs } from './DesktopChatTabs'
import type { DesktopTabLayout } from '@/lib/desktop/session-tabs'
import { pendingTabWrite } from '@/lib/desktop/tab-writes'
import { cancelDraftShutdown, flushDesktopDrafts, forgetCoworkerDrafts, holdDraftAdmission, isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { flushDesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers'
import type { DesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers.schema'
import type { DesktopOpenChat } from '@/lib/desktop/control-center-chats'
import type { DesktopChatRequest } from '@/lib/desktop/chat-request'
import type { DesktopCoworkerPanel } from '@/lib/desktop/coworker-panel'
import type { DesktopCoworkerPanelRequest } from '@/lib/desktop/coworker-panel-request'

export type DesktopAgentView = { id: string; name: string; description: string; createdAt: string; updatedAt: string; position?: GridPosition | null; spaceId?: string; enabled?: boolean }
export type DesktopSessionView = { id: string; agentId: string; title: string; createdAt: string; updatedAt: string }
export type DesktopBootstrap = ConnectionsList & {
    theme: ThemePreference
    profile: { id: number; displayName: string }
    workspace: { id: number; name: string }
    iconCatalogId?: string | null
    iconUploadId?: string | null
    agents: DesktopAgentView[]
    board?: DesktopBoardState
    recentCoworkers?: DesktopRecentCoworkers
}

async function json<T>(response: Response): Promise<T> {
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'The local service could not complete that action')
    return body as T
}

export function DesktopApp({ initialData }: { initialData: DesktopBootstrap }) {
    const boardState = useDesktopBoardState(initialData.board)
    const [boardInteraction, setBoardInteraction] = useState(false)
    const [controlCenterOpen, setControlCenterOpen] = useState(false)
    const [shortcutsOpen, setShortcutsOpen] = useState(false)
    const [sharedDataOpen, setSharedDataOpen] = useState(false)
    const [placingCopy, setPlacingCopy] = useState(false)
    const [quitting, setQuitting] = useState(false)
    useEffect(() => {
        const bridge = (window as Window & { desktopApp?: {
            onBeforeQuit?: (listener: () => Promise<boolean>) => () => void
            onQuitCancelled?: (listener: () => void) => () => void
        } }).desktopApp
        const stop = bridge?.onBeforeQuit?.(async () => {
            setQuitting(true)
            setControlCenterOpen(false)
            setShortcutsOpen(false)
            setSharedDataOpen(false)
            // Freeze chat admissions synchronously, then let best-effort navigation history
            // settle alongside the existing durable draft handshake.
            const [ready] = await Promise.all([flushDesktopDrafts(), flushDesktopRecentCoworkers()])
            if (!ready) setQuitting(false)
            return ready
        })
        const cancel = bridge?.onQuitCancelled?.(() => { cancelDraftShutdown(); setQuitting(false) })
        return () => { stop?.(); cancel?.() }
    }, [])
    const [preference, setPreference] = useState(initialData.theme)
    const { theme, resolvedTheme, setTheme } = useTheme()
    const [themeSaving, setThemeSaving] = useState(false)
    const themeSavingRef = useRef(false)
    const themeErrorToast = useRef<string | number | undefined>(undefined)
    const [recenterSignal, setRecenterSignal] = useState(0)
    const [newBoxSignal, setNewBoxSignal] = useState(0)
    const [boardFocus, setBoardFocus] = useState<{ tileId: string; nonce: number; insetRight: number } | null>(null)
    useEffect(() => {
        if (theme !== preference) setTheme(preference)
    }, [theme, preference, setTheme])
    const [providers, setProviders] = useState<ConnectionsList>({ connections: initialData.connections, default: initialData.default })
    const providerRead = useRef<AbortController | null>(null)
    const refreshProviders = useCallback(async () => {
        if (providerRead.current && !providerRead.current.signal.aborted) return
        const read = new AbortController()
        providerRead.current = read
        try {
            const response = await fetch('/api/desktop/settings', { signal: read.signal, cache: 'no-store' })
            if (!response.ok) return
            const snapshot = connectionsListSchema.parse(await response.json())
            if (!read.signal.aborted) setProviders(snapshot)
        } finally {
            if (providerRead.current === read) providerRead.current = null
        }
    }, [])
    useVisibleInterval(refreshProviders, 5000)
    useEffect(() => () => providerRead.current?.abort(), [])
    const applyProviders = useCallback((snapshot: ConnectionsList) => {
        // A read begun before a settings or sign-in change must not undo that change.
        providerRead.current?.abort()
        setProviders(snapshot)
    }, [])
    const [workspaceName, setWorkspaceName] = useState(initialData.workspace.name)
    const [savedIcon, setSavedIcon] = useState({ iconCatalogId: initialData.iconCatalogId ?? null, iconUploadId: initialData.iconUploadId ?? null })
    const [workspaceSettings, setWorkspaceSettings] = useState(false)
    const [settings, setSettings] = useState(false)
    useEffect(() => {
        const openSettings = (event: KeyboardEvent) => {
            if (event.metaKey && event.key === ',' && !shortcutsOpen && !sharedDataOpen && !workspaceSettings && !boardInteraction && !boardState.saving && !themeSavingRef.current && !isDesktopQuitting()) { event.preventDefault(); setSettings(true) }
        }
        window.addEventListener('keydown', openSettings)
        return () => window.removeEventListener('keydown', openSettings)
    }, [workspaceSettings, shortcutsOpen, sharedDataOpen, boardInteraction, boardState.saving])
    const [agents, setAgents] = useState(initialData.agents)
    const boardActivity = useBoardActivity(agents.map(agent => agent.id))
    // Responses already in flight cannot reintroduce a coworker after its confirmed deletion.
    const deletedAgents = useRef(new Set<string>())
    const [creating, setCreating] = useState(false)
    const [creatingSpaceId, setCreatingSpaceId] = useState<string>()
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
    const selectedAgentRef = useRef(selectedAgentId)
    selectedAgentRef.current = selectedAgentId
    const [panelOpen, setPanelOpen] = useState(false)
    const [visibleSession, setVisibleSession] = useState<{ agentId: string; sessionId: string | null } | null>(null)
    const reportVisibleSession = useCallback((agentId: string, sessionId: string | null) => {
        if (selectedAgentRef.current !== agentId) return
        setVisibleSession(previous => previous?.agentId === agentId && previous.sessionId === sessionId ? previous : { agentId, sessionId })
    }, [])
    const [panelInsetRight, setPanelInsetRight] = useState(0)
    const boardFrame = useRef<HTMLDivElement>(null)
    const panelContent = useRef<HTMLElement>(null)
    const [requestedSession, setRequestedSession] = useState<DesktopChatRequest | null>(null)
    const [requestedPanel, setRequestedPanel] = useState<DesktopCoworkerPanelRequest | null>(null)
    const panelRequestNonce = useRef(0)
    const panelRequestHandled = useCallback((request: DesktopCoworkerPanelRequest) => {
        setRequestedPanel(current => current === request ? null : current)
    }, [])
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const connected = providers.connections.some(c => c.connected)
    const available = providers.connections.filter(c => c.connected && !c.credentialRejected)
    const defaultProvider = available.find(c => c.id === providers.default?.connectionId)
    const sidebarProvider = defaultProvider ?? available[0]
    const selectedAgent = agents.find(agent => agent.id === selectedAgentId) ?? null
    const currentAgents = useRef(agents)
    currentAgents.current = agents
    const controlCenterDisabled = settings || workspaceSettings || shortcutsOpen || sharedDataOpen || creating || !!busy || placingCopy || quitting || themeSaving || boardInteraction || boardState.saving

    useEffect(() => {
        if (panelOpen && !settings && !requestedPanel) panelContent.current?.focus({ preventScroll: true })
    }, [panelOpen, selectedAgentId, requestedSession, settings])

    useEffect(() => {
        const panel = panelContent.current?.closest<HTMLElement>('[data-side-panel]')
        if (!panelOpen || !panel) return
        const wide = window.matchMedia('(min-width: 768px)')
        const measure = () => setPanelInsetRight(wide.matches ? panel.offsetWidth + SIDE_PANEL_GAP : 0)
        const observer = new ResizeObserver(measure)
        observer.observe(panel)
        measure()
        wide.addEventListener('change', measure)
        return () => { observer.disconnect(); wide.removeEventListener('change', measure) }
    }, [panelOpen])

    async function saveSettings(change: SettingsChange) {
        const response = await fetch('/api/desktop/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(change),
        })
        applyProviders(await json<ConnectionsList>(response))
        if (change.action === 'appearance') setPreference(change.theme)
        if (change.action === 'workspace') setWorkspaceName(change.name)
    }

    async function saveThemeFromControlCenter(next: 'light' | 'dark') {
        if (themeSavingRef.current || isDesktopQuitting()) return
        themeSavingRef.current = true
        setThemeSaving(true)
        if (themeErrorToast.current !== undefined) toast.dismiss(themeErrorToast.current)
        themeErrorToast.current = undefined
        // The existing SQLite setting, not localhost storage, must survive app restarts. Keep
        // the current appearance until persistence succeeds and include this write in Quit.
        const release = holdDraftAdmission()
        try { await saveSettings({ action: 'appearance', theme: next }) }
        catch (cause) {
            themeErrorToast.current = toast.error('Could not save theme.', {
                description: cause instanceof Error ? cause.message : 'Try again.',
                action: { label: 'Retry', onClick: () => { void saveThemeFromControlCenter(next) } },
            })
        } finally {
            themeSavingRef.current = false
            setThemeSaving(false)
            release()
        }
    }

    async function createCoworker(event: React.FormEvent) {
        event.preventDefault()
        if (!connected || !name.trim() || busy) return
        setBusy('agent')
        setError(null)
        try {
            const body = await json<{ agent: DesktopAgentView }>(await fetch('/api/desktop/agents', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name, description, ...(creatingSpaceId && { spaceId: creatingSpaceId }) }),
            }))
            setAgents(current => [...current, body.agent])
            await boardState.refresh()
            setName('')
            setDescription('')
            selectCoworker(body.agent.id)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not create coworker')
        } finally {
            setBusy(null)
        }
    }

    async function renameCoworker(id: string, name: string) {
        const { agent } = await json<{ agent: DesktopAgentView }>(await fetch(`/api/desktop/agents/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
        }))
        mergeBoardAgents([agent])
    }

    async function setCoworkerEnabled(id: string, enabled: boolean) {
        const { agent } = await json<{ agent: DesktopAgentView }>(await fetch(`/api/desktop/agents/${encodeURIComponent(id)}/enabled`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled }),
        }))
        mergeBoardAgents([agent])
    }

    async function deleteCoworker(id: string, confirmationName: string) {
        const result = await json<{ deletedAgentId: string }>(await fetch(`/api/desktop/agents/${encodeURIComponent(id)}`, {
            method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmationName }),
        }))
        if (result.deletedAgentId !== id) throw new Error('Could not confirm this coworker was deleted. Try again.')
        deletedAgents.current.add(id)
        forgetCoworkerDrafts(id)
        setAgents(current => current.filter(agent => agent.id !== id))
        if (selectedAgentRef.current === id) {
            selectedAgentRef.current = null
            setSelectedAgentId(null)
            setRequestedSession(null)
            setPanelOpen(false)
            setPanelInsetRight(0)
        }
        await boardState.refresh()
    }

    async function duplicateCoworker(id: string, requestId: string, position: GridPosition, spaceId?: string): Promise<'created' | 'occupied'> {
        const response = await fetch(`/api/desktop/agents/${encodeURIComponent(id)}/duplicate`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, position, ...(spaceId && { spaceId }) }),
        })
        if (response.status === 409 && (await response.clone().json().catch(() => null))?.code === 'position_occupied') {
            const { agents: latest } = await json<{ agents: DesktopAgentView[] }>(await fetch('/api/desktop/agents', { cache: 'no-store' }))
            mergeBoardAgents(latest)
            await boardState.refresh()
            return 'occupied'
        }
        const { agent } = await json<{ agent: DesktopAgentView }>(response)
        mergeBoardAgents([agent])
        await boardState.refresh()
        selectCoworker(agent.id)
        return 'created'
    }

    function mergeBoardAgents(incoming: DesktopAgentView[]) {
        setAgents(current => {
            const merged = new Map(current.map(agent => [agent.id, agent]))
            for (const agent of incoming) {
                if (deletedAgents.current.has(agent.id)) continue
                const existing = merged.get(agent.id)
                if (!existing || existing.updatedAt <= agent.updatedAt) merged.set(agent.id, agent)
            }
            return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        })
    }

    function showBoard(create = false, spaceId?: string) {
        setRequestedPanel(null)
        setSettings(false)
        setCreating(create)
        setCreatingSpaceId(create ? spaceId : undefined)
        setPanelOpen(false)
        setError(null)
    }

    function closePanel() {
        setRequestedPanel(null)
        setPanelOpen(false)
        const tile = Array.from(boardFrame.current?.querySelectorAll<HTMLElement>('[data-tile-id]') ?? [])
            .find(element => element.dataset.tileId === selectedAgentId)
        tile?.focus({ preventScroll: true })
    }

    function selectCoworker(agentId: string, sessionId: string | null = null, openChat?: DesktopOpenChat) {
        if (isDesktopQuitting() || deletedAgents.current.has(agentId)) return
        setRequestedPanel(null)
        setSettings(false)
        setCreating(false)
        selectedAgentRef.current = agentId
        setSelectedAgentId(agentId)
        setPanelOpen(true)
        setRequestedSession(openChat ? { tabUid: openChat.tabUid, sessionId: openChat.sessionId } : sessionId ? { id: sessionId } : null)
        setError(null)
    }

    function focusFromControlCenter(agentId: string) {
        if (currentAgents.current.some(agent => agent.id === agentId) && !isDesktopQuitting())
            setBoardFocus(current => ({ tileId: agentId, nonce: (current?.nonce ?? 0) + 1,
                // Match the original IsoBoard: the first opening has no measured panel yet.
                insetRight: window.matchMedia('(min-width: 768px)').matches ? loadSidePanelWidth(window.innerWidth) + SIDE_PANEL_GAP : 0 }))
    }

    function openCoworkerPanel(agentId: string, panel: DesktopCoworkerPanel) {
        if (controlCenterDisabled || isDesktopQuitting() || deletedAgents.current.has(agentId)
            || !currentAgents.current.some(agent => agent.id === agentId)) return
        selectCoworker(agentId)
        setRequestedPanel({ agentId, panel, nonce: ++panelRequestNonce.current })
    }

    function openSavedConversation(hit: DesktopConversationHit) {
        if (currentAgents.current.some(agent => agent.id === hit.agentId)) selectCoworker(hit.agentId, hit.id)
    }

    const openSettings = () => { if (!themeSavingRef.current && !isDesktopQuitting()) setSettings(true) }
    const openShortcuts = () => { if (!controlCenterDisabled && !isDesktopQuitting()) setShortcutsOpen(true) }
    const modelLabel = defaultProvider ? providers.default?.model : undefined
    const workspaceMenu = <DesktopWorkspaceMenu workspaceName={workspaceName} {...savedIcon} profileName={initialData.profile.displayName}
        agents={agents} selected={panelOpen ? selectedAgentId : null} providerLabel={sidebarProvider && PROVIDER_LABELS[sidebarProvider.provider]}
        modelLabel={modelLabel} onBoard={() => showBoard()} onCoworker={selectCoworker} onSettings={openSettings}
        onWorkspaceSettings={() => { if (!isDesktopQuitting()) setWorkspaceSettings(true) }}
        onShortcuts={openShortcuts}
        onSharedData={() => { if (!controlCenterDisabled && !isDesktopQuitting()) setSharedDataOpen(true) }}
        onControlCenter={() => {
            if (controlCenterDisabled) return
            boardFrame.current?.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')?.focus({ preventScroll: true })
            setControlCenterOpen(true)
        }} />

    return (
        <main className="relative flex h-dvh w-full flex-col overflow-clip bg-frame text-foreground md:p-2">
            <div ref={boardFrame} inert={settings} aria-hidden={settings || undefined}
                className="relative isolate flex min-h-0 flex-1 overflow-clip bg-background md:rounded-3xl md:border md:border-border md:shadow">
                <DesktopBoard activitySnapshot={boardActivity} agents={agents} workspaceName={workspaceName} workspaceMenu={workspaceMenu} recenterSignal={recenterSignal}
                    newBoxSignal={newBoxSignal} focusRequest={boardFocus}
                    board={boardState.board} onBoardCommand={initialData.board ? boardState.command : undefined}
                    boardSaving={boardState.saving} boardError={boardState.error} onRetryBoard={boardState.retry}
                    boardDisabled={settings || workspaceSettings || shortcutsOpen || sharedDataOpen || creating || controlCenterOpen || !!busy || quitting || themeSaving}
                    onBoardInteractionChange={setBoardInteraction}
                    visibleSessionId={panelOpen && !settings && !workspaceSettings && !shortcutsOpen && !sharedDataOpen && !creating && !controlCenterOpen && !busy && !boardInteraction && visibleSession?.agentId === selectedAgentId ? visibleSession.sessionId : null}
                    selectedAgentId={panelOpen ? selectedAgentId : null} panelInsetRight={panelOpen ? panelInsetRight : 0} onOpen={selectCoworker}
                    onRename={renameCoworker} onDuplicate={duplicateCoworker} onSetEnabled={setCoworkerEnabled} onDelete={deleteCoworker}
                    onCreate={spaceId => showBoard(true, spaceId)} onDismiss={() => showBoard()} onOpenConversation={openSavedConversation} onPlacementChange={setPlacingCopy} />
                {selectedAgent && <div inert={!panelOpen || boardInteraction} aria-hidden={!panelOpen || boardInteraction || undefined}>
                    <SidePanel isOpen={panelOpen} onDismiss={closePanel}>
                        <section ref={panelContent} tabIndex={-1} aria-label="Coworker chat" className="flex h-full min-h-0 flex-col outline-none"
                            onKeyDown={event => {
                                if (event.key === 'Escape' && !event.defaultPrevented && event.currentTarget.contains(event.target as Node)) {
                                    event.preventDefault()
                                    closePanel()
                                }
                            }}>
                            <CoworkerChat key={selectedAgent.id} agent={selectedAgent} requested={requestedSession} selected={panelOpen && !settings && !workspaceSettings && !shortcutsOpen && !sharedDataOpen && !boardInteraction}
                                requestedPanel={requestedPanel?.agentId === selectedAgent.id ? requestedPanel : null} onPanelRequestHandled={panelRequestHandled}
                                onVisibleSession={reportVisibleSession}
                                onClosePanel={closePanel} modelLabel={modelLabel} onOpenModelSettings={openSettings} />
                        </section>
                    </SidePanel>
                </div>}
            </div>
            {settings && <div className="absolute inset-0 z-50 flex flex-col bg-background md:m-2 md:overflow-hidden md:rounded-3xl md:border">
                <div className="border-b px-4 py-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setSettings(false)}><ArrowLeft />{panelOpen ? 'Back to chat' : 'Team board'}</Button>
                </div>
                <DesktopSettings providers={providers} workspaceName={workspaceName} onSave={saveSettings} onProviders={applyProviders} />
            </div>}
            <Dialog open={creating} onOpenChange={open => { if (!busy) setCreating(open) }} asSheet={false}>
                {creating && <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{agents.length ? 'Add a coworker' : 'Create your first coworker'}</DialogTitle>
                        <DialogDescription>{connected ? 'Give your coworker a name and a task, then start a local conversation.' : 'Connect an AI provider in Settings, then create a coworker.'}</DialogDescription>
                    </DialogHeader>
                    {error && <div role="alert" className="text-sm text-destructive">{error}</div>}
                    <form onSubmit={createCoworker} className="space-y-3">
                        <div>
                            <label htmlFor="coworker-name" className="mb-1.5 block text-sm font-medium">Name</label>
                            <Input id="coworker-name" placeholder="Researcher" maxLength={60} value={name} onChange={event => setName(event.target.value)} />
                        </div>
                        <div>
                            <label htmlFor="coworker-description" className="mb-1.5 block text-sm font-medium">What should they do?</label>
                            <Textarea id="coworker-description" placeholder="Finds answers and drafts a summary." maxLength={2000} rows={4} value={description} onChange={event => setDescription(event.target.value)} />
                        </div>
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" disabled={!!busy} onClick={() => setCreating(false)}>Cancel</Button>
                            <Button type="submit" disabled={!connected || !name.trim() || busy === 'agent'}>{busy === 'agent' ? 'Creating…' : 'Create coworker'}</Button>
                        </div>
                    </form>
                </DialogContent>}
            </Dialog>
            <DesktopWorkspaceSettings open={workspaceSettings} onOpenChange={setWorkspaceSettings} workspaceName={workspaceName}
                onSaved={saved => { setWorkspaceName(saved.name); setSavedIcon({ iconCatalogId: saved.iconCatalogId ?? null, iconUploadId: saved.iconUploadId ?? null }) }} />
            <DesktopSharedData hideTrigger dialogControl={{ open: sharedDataOpen, onOpenChange: setSharedDataOpen }} onCloseAutoFocus={event => {
                const target = boardFrame.current?.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')
                if (target && !isDesktopQuitting()) { event.preventDefault(); target.focus({ preventScroll: true }) }
            }} />
            <DesktopShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} onCloseAutoFocus={event => {
                const target = boardFrame.current?.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')
                if (target && !isDesktopQuitting()) { event.preventDefault(); target.focus({ preventScroll: true }) }
            }} />
            <DesktopControlCenter activity={boardActivity} onRefreshActivity={boardActivity.refresh} coworkers={agents} selectedCoworkerId={panelOpen ? selectedAgentId : null} initialRecent={initialData.recentCoworkers}
                open={controlCenterOpen} onOpenChange={setControlCenterOpen} disabled={controlCenterDisabled}
                board={boardState.board}
                onAddBox={initialData.board && !boardState.error ? () => { if (!controlCenterDisabled && !isDesktopQuitting()) setNewBoxSignal(signal => signal + 1) } : undefined}
                onMoveCoworker={initialData.board && !boardState.error ? (agentId, spaceId) => {
                    if (!controlCenterDisabled && !isDesktopQuitting() && currentAgents.current.some(agent => agent.id === agentId))
                        void boardState.command({ kind: 'move-agent', agentId, spaceId }).catch(() => {})
                } : undefined}
                onOpenCoworker={id => { if (currentAgents.current.some(agent => agent.id === id)) { focusFromControlCenter(id); selectCoworker(id) } }}
                onOpenChat={chat => { if (currentAgents.current.some(agent => agent.id === chat.agentId)) { focusFromControlCenter(chat.agentId); selectCoworker(chat.agentId, null, chat) } }}
                onOpenCoworkerPanel={(agentId, panel) => { focusFromControlCenter(agentId); openCoworkerPanel(agentId, panel) }}
                onOpenConversation={hit => { focusFromControlCenter(hit.agentId); openSavedConversation(hit) }} onAddCoworker={() => showBoard(true)}
                onWorkspaceSettings={() => { if (!isDesktopQuitting()) setWorkspaceSettings(true) }}
                onRecenterBoard={() => { if (!isDesktopQuitting()) setRecenterSignal(signal => signal + 1) }}
                darkTheme={resolvedTheme === 'dark'}
                onToggleTheme={resolvedTheme === 'dark' || resolvedTheme === 'light' ? () => { void saveThemeFromControlCenter(resolvedTheme === 'dark' ? 'light' : 'dark') } : undefined}
                onShortcuts={openShortcuts}
                onModelSettings={openSettings} onBackToBoard={() => showBoard()} />
        </main>
    )
}

function CoworkerChat({ agent, requested, requestedPanel, onPanelRequestHandled, selected, modelLabel, onOpenModelSettings, onClosePanel, onVisibleSession }: {
    agent: DesktopAgentView
    requested: DesktopChatRequest | null
    requestedPanel: DesktopCoworkerPanelRequest | null
    onPanelRequestHandled: (request: DesktopCoworkerPanelRequest) => void
    selected: boolean
    onVisibleSession?: (agentId: string, sessionId: string | null) => void
    modelLabel?: string
    onOpenModelSettings: () => void
    onClosePanel: () => void
}) {
    const [sessions, setSessions] = useState<DesktopSessionView[] | null>(null)
    const [bootstrap, setBootstrap] = useState<{ layout: DesktopTabLayout | null } | null>(null)
    const [error, setError] = useState<string | null>(null)
    const url = `/api/desktop/agents/${encodeURIComponent(agent.id)}/sessions`
    const sessionRead = useRef<AbortController | null>(null)

    const readSessions = useCallback(async (restoreTabs = false) => {
        sessionRead.current?.abort()
        const controller = new AbortController()
        sessionRead.current = controller
        try {
            if (restoreTabs) await pendingTabWrite(agent.id)
            const body = await json<{ sessions: DesktopSessionView[]; tabs?: DesktopTabLayout | null }>(await fetch(url, { signal: controller.signal, cache: 'no-store' }))
            if (controller.signal.aborted) return
            setSessions(body.sessions)
            if (restoreTabs) setBootstrap({ layout: body.tabs ?? null })
            setError(null)
        } catch (cause) {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load conversations')
        }
    }, [agent.id, url])

    useEffect(() => {
        // State changes in readSessions happen only after the asynchronous request.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void readSessions(true)
        return () => sessionRead.current?.abort()
    }, [readSessions])

    const missing = !!requested && 'id' in requested && !!sessions && !sessions.some(s => s.id === requested.id)
    const dismiss = <Button type="button" variant="ghost" size="icon-sm" aria-label="Close panel" className="absolute right-3 top-3" onClick={onClosePanel}><X /></Button>
    const reload = () => { setBootstrap(null); void readSessions(true) }
    return <>
        {(error || missing) && <div role="alert" className="flex flex-wrap items-center gap-2 px-5 py-2 text-sm text-destructive">
            {error ?? 'This conversation is no longer available for this coworker.'}
            <Button type="button" size="sm" variant="outline" onClick={reload}>Retry conversations</Button>
        </div>}
        {!error && !bootstrap && <p role="status" className="p-5 text-sm text-muted-foreground">Opening {agent.name}…</p>}
        {missing || !bootstrap || !sessions ? dismiss : <DesktopChatTabs
            agent={agent} selected={selected} requested={requested} requestedPanel={requestedPanel} onPanelRequestHandled={onPanelRequestHandled} sessions={sessions} initialLayout={bootstrap.layout}
            onVisibleSession={onVisibleSession}
            refreshSessions={readSessions} reload={reload} modelLabel={modelLabel} onOpenModelSettings={onOpenModelSettings} onClosePanel={onClosePanel} />}
    </>
}
