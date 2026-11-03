'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import type { ThemePreference } from '@rerun/ui/theme'
import type { ConnectionsList } from '@rerun/contracts'
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
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const connected = providers.connections.some(c => c.connected)
    const selectedAgent = agents.find(agent => agent.id === selectedAgentId) ?? null

    async function saveSettings(change: SettingsChange) {
        const response = await fetch('/api/desktop/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(change),
        })
        setProviders(await json<ConnectionsList>(response))
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
        setError(null)
    }

    function selectCoworker(agentId: string) {
        setSettings(false)
        setCreating(false)
        setSelectedAgentId(agentId)
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
                <button type="button" aria-keyshortcuts="Meta+," aria-current={settings ? 'page' : undefined} onClick={() => setSettings(true)}
                    className="flex shrink-0 items-center gap-2 border-t px-5 py-3 text-sm font-medium hover:bg-accent aria-[current=page]:bg-accent">
                    <Settings className="size-4" aria-hidden /> Settings
                </button>
            </aside>

            <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
                {settings ? <DesktopSettings providers={providers} workspaceName={workspaceName} onSave={saveSettings} onProviders={setProviders} /> : <>
                    {!connected && <div className="flex items-center justify-between gap-3 border-b px-5 py-2 text-sm">
                        <span>Connect an AI provider to chat with your coworkers.</span>
                        <Button size="sm" onClick={() => setSettings(true)}>Set up provider</Button>
                    </div>}
                    {error && <div role="alert" className="border-b bg-destructive/10 px-5 py-2 text-sm text-destructive">{error}</div>}

                    {selectedAgent ? (
                        <CoworkerChat key={selectedAgent.id} agent={selectedAgent} />
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
                        <DesktopBoard agents={agents} workspaceName={workspaceName} onOpen={selectCoworker} onCreate={() => showBoard(true)} />
                    )}
                </>}
            </section>
        </main>
    )
}

function CoworkerChat({ agent }: { agent: DesktopAgentView }) {
    const [sessions, setSessions] = useState<DesktopSessionView[] | null>(null)
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const url = `/api/desktop/agents/${encodeURIComponent(agent.id)}/sessions`

    useEffect(() => {
        const controller = new AbortController()
        void fetch(url, { signal: controller.signal }).then(response => json<{ sessions: DesktopSessionView[] }>(response)).then(body => {
            if (controller.signal.aborted) return
            setSessions(body.sessions)
            setSelectedId(body.sessions[0]?.id ?? null)
        }).catch(cause => {
            if (!controller.signal.aborted) {
                setSessions([])
                setError(cause instanceof Error ? cause.message : 'Could not load conversations')
            }
        })
        return () => controller.abort()
    }, [url])

    const refreshSession = useCallback(async (id: string) => {
        setSelectedId(id)
        try {
            const body = await json<{ sessions: DesktopSessionView[] }>(await fetch(url))
            setSessions(body.sessions)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not refresh conversations')
        }
    }, [url])

    if (!sessions) return <p role="status" className="p-5 text-sm text-muted-foreground">Opening {agent.name}…</p>
    return (
        <>
            {error && <p role="alert" className="px-5 py-2 text-sm text-destructive">{error}</p>}
            <DesktopConversation agent={agent} sessionId={selectedId} sessions={sessions} onSelectSession={setSelectedId} onChatSession={refreshSession} />
        </>
    )
}
