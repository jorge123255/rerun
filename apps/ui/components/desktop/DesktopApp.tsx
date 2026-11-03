'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import type { ThemePreference } from '@rerun/ui/theme'
import { connectionsListSchema, PROVIDER_LABELS, type ConnectionsList } from '@rerun/contracts'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import type { SettingsChange } from '@/lib/desktop/settings'
import { DesktopSettings } from './DesktopSettings'
import { ArrowLeft, X } from 'lucide-react'
import { SidePanel } from '@/components/layout/SidePanel'
import { SIDE_PANEL_GAP } from '@/lib/side-panel-width'
import { DesktopWorkspaceMenu } from './DesktopWorkspaceMenu'
import { DesktopBoard } from './DesktopBoard'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DesktopConversation } from './DesktopConversation'
import { DesktopChatHistory } from './DesktopChatHistory'
import { DesktopRunHistory } from './DesktopRunHistory'

export type DesktopAgentView = { id: string; name: string; description: string; createdAt: string; updatedAt: string }
export type DesktopSessionView = { id: string; agentId: string; title: string; createdAt: string; updatedAt: string }
export type DesktopBootstrap = ConnectionsList & {
    theme: ThemePreference
    profile: { id: number; displayName: string }
    workspace: { id: number; name: string }
    agents: DesktopAgentView[]
}

async function json<T>(response: Response): Promise<T> {
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'The local service could not complete that action')
    return body as T
}

export function DesktopApp({ initialData }: { initialData: DesktopBootstrap }) {
    const [preference, setPreference] = useState(initialData.theme)
    const { theme, setTheme } = useTheme()
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
    const [settings, setSettings] = useState(false)
    useEffect(() => {
        const openSettings = (event: KeyboardEvent) => {
            if (event.metaKey && event.key === ',') { event.preventDefault(); setSettings(true) }
        }
        window.addEventListener('keydown', openSettings)
        return () => window.removeEventListener('keydown', openSettings)
    }, [])
    const [agents, setAgents] = useState(initialData.agents)
    const [creating, setCreating] = useState(false)
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
    const [panelOpen, setPanelOpen] = useState(false)
    const [panelInsetRight, setPanelInsetRight] = useState(0)
    const boardFrame = useRef<HTMLDivElement>(null)
    const panelContent = useRef<HTMLElement>(null)
    const [requestedSessionId, setRequestedSessionId] = useState<string | null>(null)
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const connected = providers.connections.some(c => c.connected)
    const available = providers.connections.filter(c => c.connected && !c.credentialRejected)
    const defaultProvider = available.find(c => c.id === providers.default?.connectionId)
    const sidebarProvider = defaultProvider ?? available[0]
    const selectedAgent = agents.find(agent => agent.id === selectedAgentId) ?? null

    useEffect(() => {
        if (panelOpen && !settings) panelContent.current?.focus({ preventScroll: true })
    }, [panelOpen, selectedAgentId, requestedSessionId, settings])

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

    async function createCoworker(event: React.FormEvent) {
        event.preventDefault()
        if (!connected || !name.trim() || busy) return
        setBusy('agent')
        setError(null)
        try {
            const body = await json<{ agent: DesktopAgentView }>(await fetch('/api/desktop/agents', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name, description }),
            }))
            setAgents(current => [...current, body.agent])
            setName('')
            setDescription('')
            selectCoworker(body.agent.id)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not create coworker')
        } finally {
            setBusy(null)
        }
    }

    function showBoard(create = false) {
        setSettings(false)
        setCreating(create)
        setPanelOpen(false)
        setError(null)
    }

    function closePanel() {
        setPanelOpen(false)
        const tile = Array.from(boardFrame.current?.querySelectorAll<HTMLElement>('[data-tile-id]') ?? [])
            .find(element => element.dataset.tileId === selectedAgentId)
        tile?.focus({ preventScroll: true })
    }

    function selectCoworker(agentId: string, sessionId: string | null = null) {
        setSettings(false)
        setCreating(false)
        setSelectedAgentId(agentId)
        setPanelOpen(true)
        setRequestedSessionId(sessionId)
        setError(null)
    }

    const openSettings = () => setSettings(true)
    const modelLabel = defaultProvider ? providers.default?.model : undefined
    const workspaceMenu = <DesktopWorkspaceMenu workspaceName={workspaceName} profileName={initialData.profile.displayName}
        agents={agents} selected={panelOpen ? selectedAgentId : null} providerLabel={sidebarProvider && PROVIDER_LABELS[sidebarProvider.provider]}
        modelLabel={modelLabel} onBoard={() => showBoard()} onCoworker={selectCoworker} onSettings={openSettings} />

    return (
        <main className="relative flex h-dvh w-full flex-col overflow-clip bg-frame text-foreground md:p-2">
            <div ref={boardFrame} inert={settings} aria-hidden={settings || undefined}
                className="relative isolate flex min-h-0 flex-1 overflow-clip bg-background md:rounded-3xl md:border md:border-border md:shadow">
                <DesktopBoard agents={agents} workspaceName={workspaceName} workspaceMenu={workspaceMenu}
                    selectedAgentId={panelOpen ? selectedAgentId : null} panelInsetRight={panelOpen ? panelInsetRight : 0} onOpen={selectCoworker}
                    onCreate={() => showBoard(true)} onDismiss={() => showBoard()} onOpenConversation={hit => selectCoworker(hit.agentId, hit.id)} />
                {selectedAgent && <div inert={!panelOpen} aria-hidden={!panelOpen || undefined}>
                    <SidePanel isOpen={panelOpen} onDismiss={closePanel}>
                        <section ref={panelContent} tabIndex={-1} aria-label="Coworker chat" className="flex h-full min-h-0 flex-col outline-none"
                            onKeyDown={event => {
                                if (event.key === 'Escape' && !event.defaultPrevented && event.currentTarget.contains(event.target as Node)) {
                                    event.preventDefault()
                                    closePanel()
                                }
                            }}>
                            <CoworkerChat key={`${selectedAgent.id}:${requestedSessionId ?? ''}`} agent={selectedAgent} initialSessionId={requestedSessionId}
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
        </main>
    )
}

function CoworkerChat({ agent, initialSessionId, modelLabel, onOpenModelSettings, onClosePanel }: {
    agent: DesktopAgentView
    initialSessionId: string | null
    modelLabel?: string
    onOpenModelSettings: () => void
    onClosePanel: () => void
}) {
    const [sessions, setSessions] = useState<DesktopSessionView[] | null>(null)
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [missingSelection, setMissingSelection] = useState(false)
    const url = `/api/desktop/agents/${encodeURIComponent(agent.id)}/sessions`
    const sessionRead = useRef<AbortController | null>(null)

    const readSessions = useCallback(async (openLatest = false) => {
        sessionRead.current?.abort()
        const controller = new AbortController()
        sessionRead.current = controller
        try {
            const body = await json<{ sessions: DesktopSessionView[] }>(await fetch(url, { signal: controller.signal, cache: 'no-store' }))
            if (controller.signal.aborted) return
            setSessions(body.sessions)
            setError(null)
            if (openLatest) {
                const chosen = initialSessionId ? body.sessions.find(session => session.id === initialSessionId) : body.sessions[0]
                const missing = !!initialSessionId && !chosen
                setMissingSelection(missing)
                if (missing) setError('This conversation is no longer available for this coworker.')
                setSelectedId(chosen?.id ?? null)
            }
        } catch (cause) {
            if (!controller.signal.aborted) {
                setSessions(current => current ?? [])
                if (openLatest && initialSessionId) setMissingSelection(true)
                setError(cause instanceof Error ? cause.message : 'Could not load conversations')
            }
        }
    }, [url, initialSessionId])

    useEffect(() => {
        // State changes in readSessions happen only after the asynchronous request.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void readSessions(true)
        return () => sessionRead.current?.abort()
    }, [readSessions])

    const refreshSession = useCallback(async (id: string) => {
        setSelectedId(id)
        await readSessions()
    }, [readSessions])

    const dismiss = <Button type="button" variant="ghost" size="icon-sm" aria-label="Close panel" className="absolute right-3 top-3"
        onClick={onClosePanel}><X /></Button>
    if (!sessions) return <>{dismiss}<p role="status" className="p-5 text-sm text-muted-foreground">Opening {agent.name}…</p></>
    return (
        <>
            {error && <div role="alert" className="flex flex-wrap items-center gap-2 px-5 py-2 text-sm text-destructive">{error}
                <Button type="button" size="sm" variant="outline" onClick={() => void readSessions(missingSelection || (!!initialSessionId && !selectedId))}>Retry conversations</Button>
            </div>}
            {missingSelection && dismiss}
            {!missingSelection && <DesktopConversation agent={agent} sessionId={selectedId} sessions={sessions} onSelectSession={setSelectedId} onChatSession={refreshSession}
                modelLabel={modelLabel} onOpenModelSettings={onOpenModelSettings} onClosePanel={onClosePanel}
                renderHistory={busy => <DesktopChatHistory sessions={sessions} selectedId={selectedId} busy={busy} onSelect={setSelectedId} />} renderRunHistory={<DesktopRunHistory agent={agent} />} />}
        </>
    )
}
