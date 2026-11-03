'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import type { ThemePreference } from '@rerun/ui/theme'
import { connectionsListSchema, PROVIDER_LABELS, type ConnectionsList } from '@rerun/contracts'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import type { SettingsChange } from '@/lib/desktop/settings'
import { DesktopSettings } from './DesktopSettings'
import { LayoutGrid, Settings } from 'lucide-react'
import { DesktopBoard } from './DesktopBoard'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
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
        setSelectedAgentId(null)
        setRequestedSessionId(null)
        setError(null)
    }

    function selectCoworker(agentId: string, sessionId: string | null = null) {
        setSettings(false)
        setCreating(false)
        setSelectedAgentId(agentId)
        setRequestedSessionId(sessionId)
        setError(null)
    }

    return (
        <main className="flex h-[100dvh] flex-col bg-background text-foreground md:flex-row">
            <aside className="flex max-h-[38dvh] w-full shrink-0 flex-col border-b bg-muted/20 md:max-h-none md:w-80 md:border-b-0 md:border-r">
                <div className="shrink-0 border-b px-5 py-5">
                    <div className="text-lg font-semibold tracking-tight">Rerun Local</div>
                    <div className="mt-1 text-sm text-muted-foreground">{workspaceName} · {initialData.profile.displayName}</div>
                    <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-700 dark:text-emerald-400">
                        <span className="size-1.5 rounded-full bg-emerald-500" /> Local data only
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto p-3">
                    <button type="button" onClick={() => showBoard()} aria-current={!settings && !creating && !selectedAgent ? 'page' : undefined}
                        className="mb-4 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium hover:bg-accent aria-[current=page]:bg-accent">
                        <LayoutGrid aria-hidden className="size-4" /> Team board
                    </button>
                    <div className="px-2 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Coworkers</div>
                    {agents.length === 0 && <div className="px-2 py-6 text-sm text-muted-foreground">No coworkers yet.</div>}
                    <div className="space-y-1">
                        {agents.map(agent => (
                            <button
                                key={agent.id}
                                type="button"
                                onClick={() => void selectCoworker(agent.id)}
                                className={cn('w-full rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent', selectedAgentId === agent.id && 'bg-accent')}
                            >
                                <div className="truncate text-sm font-medium">{agent.name}</div>
                                {agent.description && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{agent.description}</div>}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="shrink-0 border-t px-5 py-2">
                    {sidebarProvider ? <div role="status" className="text-sm">
                        <div className="flex items-center gap-2 font-medium">
                            <span aria-hidden className="size-2 rounded-full bg-emerald-500" />
                            <span>{PROVIDER_LABELS[sidebarProvider.provider]} is connected</span>
                        </div>
                        <span className="block truncate pl-4 text-xs text-muted-foreground">{defaultProvider ? providers.default?.model : 'Choose a default model in Settings.'}</span>
                    </div> : <Button size="sm" variant="outline" onClick={() => setSettings(true)}>Set up provider</Button>}
                </div>
                <button type="button" aria-keyshortcuts="Meta+," aria-current={settings ? 'page' : undefined} onClick={() => setSettings(true)}
                    className="flex shrink-0 items-center gap-2 border-t px-5 py-3 text-sm font-medium hover:bg-accent aria-[current=page]:bg-accent">
                    <Settings className="size-4" aria-hidden /> Settings
                </button>
            </aside>

            <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
                {settings ? <DesktopSettings providers={providers} workspaceName={workspaceName} onSave={saveSettings} onProviders={applyProviders} /> : <>
                    {error && <div role="alert" className="border-b bg-destructive/10 px-5 py-2 text-sm text-destructive">{error}</div>}

                    {selectedAgent ? (
                        <CoworkerChat key={`${selectedAgent.id}:${requestedSessionId ?? ''}`} agent={selectedAgent} initialSessionId={requestedSessionId} />
                    ) : creating ? (
                        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-6 md:items-center">
                            <Card className="w-full max-w-xl shadow-none">
                                <CardHeader>
                                    <CardTitle>{agents.length ? 'Add a coworker' : 'Create your first coworker'}</CardTitle>
                                    <CardDescription>{connected ? 'Give your coworker a name and a task, then start a local conversation.' : 'Connect an AI provider in Settings, then create a coworker.'}</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <form onSubmit={createCoworker} className="space-y-3">
                                        <div>
                                            <label htmlFor="coworker-name" className="mb-1.5 block text-sm font-medium">Name</label>
                                            <Input id="coworker-name" placeholder="Researcher" maxLength={60} value={name} onChange={event => setName(event.target.value)} />
                                        </div>
                                        <div>
                                            <label htmlFor="coworker-description" className="mb-1.5 block text-sm font-medium">What should they do?</label>
                                            <Textarea id="coworker-description" placeholder="Find clear answers and explain the result." maxLength={2000} rows={4} value={description} onChange={event => setDescription(event.target.value)} />
                                        </div>
                                        <div className="flex gap-2">
                                            <Button type="button" variant="outline" onClick={() => showBoard()}>Cancel</Button>
                                            <Button type="submit" disabled={!connected || !name.trim() || busy === 'agent'}>{busy === 'agent' ? 'Creating…' : 'Create coworker'}</Button>
                                        </div>
                                    </form>
                                </CardContent>
                            </Card>
                        </div>
                    ) : (
                        <DesktopBoard agents={agents} workspaceName={workspaceName} onOpen={selectCoworker} onCreate={() => showBoard(true)} onOpenConversation={hit => selectCoworker(hit.agentId, hit.id)} />
                    )}
                </>}
            </section>
        </main>
    )
}

function CoworkerChat({ agent, initialSessionId }: { agent: DesktopAgentView; initialSessionId: string | null }) {
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

    if (!sessions) return <p role="status" className="p-5 text-sm text-muted-foreground">Opening {agent.name}…</p>
    return (
        <>
            {error && <div role="alert" className="flex flex-wrap items-center gap-2 px-5 py-2 text-sm text-destructive">{error}
                <Button type="button" size="sm" variant="outline" onClick={() => void readSessions(missingSelection || (!!initialSessionId && !selectedId))}>Retry conversations</Button>
            </div>}
            {!missingSelection && <DesktopConversation agent={agent} sessionId={selectedId} sessions={sessions} onSelectSession={setSelectedId} onChatSession={refreshSession}
                renderHistory={busy => <><DesktopChatHistory sessions={sessions} selectedId={selectedId} busy={busy} onSelect={setSelectedId} /><DesktopRunHistory agent={agent} /></>} />}
        </>
    )
}
