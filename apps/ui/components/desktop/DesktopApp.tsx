'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { DesktopConversation } from './DesktopConversation'

export type DesktopAgentView = { id: string; name: string; description: string; createdAt: string; updatedAt: string }
export type DesktopConnectionView = { id: string; provider: 'openai'; name: string }
export type DesktopSessionView = { id: string; agentId: string; title: string; createdAt: string; updatedAt: string }
export type DesktopBootstrap = {
    profile: { id: number; displayName: string }
    workspace: { id: number; name: string }
    agents: DesktopAgentView[]
    connections: DesktopConnectionView[]
}

async function json<T>(response: Response): Promise<T> {
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'The local service could not complete that action')
    return body as T
}

export function DesktopApp({ initialData }: { initialData: DesktopBootstrap }) {
    const [connections, setConnections] = useState(initialData.connections)
    const [agents, setAgents] = useState(initialData.agents)
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
    const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
    const [sessions, setSessions] = useState<DesktopSessionView[]>([])
    const [apiKey, setApiKey] = useState('')
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const connected = connections.length > 0
    const selectedAgent = agents.find(agent => agent.id === selectedAgentId) ?? null

    async function connectProvider(event: React.FormEvent) {
        event.preventDefault()
        if (!apiKey.trim() || busy) return
        setBusy('provider')
        setError(null)
        try {
            const body = await json<{ connection: DesktopConnectionView }>(await fetch('/api/desktop/providers/openai', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ apiKey }),
            }))
            setConnections([body.connection])
            setApiKey('')
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not connect OpenAI')
        } finally {
            setBusy(null)
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
                body: JSON.stringify({ name, description }),
            }))
            setAgents(current => [...current, body.agent])
            setName('')
            setDescription('')
            await selectCoworker(body.agent.id)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not create coworker')
        } finally {
            setBusy(null)
        }
    }

    async function selectCoworker(agentId: string) {
        setSelectedAgentId(agentId)
        setSelectedSessionId(null)
        setSessions([])
        setError(null)
        try {
            const body = await json<{ sessions: DesktopSessionView[] }>(await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/sessions`))
            setSessions(body.sessions)
            setSelectedSessionId(body.sessions[0]?.id ?? null)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not load conversations')
        }
    }

    return (
        <main className="flex h-[100dvh] flex-col bg-background text-foreground md:flex-row">
            <aside className="flex max-h-[38dvh] w-full shrink-0 flex-col border-b bg-muted/20 md:max-h-none md:w-80 md:border-b-0 md:border-r">
                <div className="shrink-0 border-b px-5 py-5">
                    <div className="text-lg font-semibold tracking-tight">Rerun Local</div>
                    <div className="mt-1 text-sm text-muted-foreground">{initialData.workspace.name} · {initialData.profile.displayName}</div>
                    <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-700 dark:text-emerald-400">
                        <span className="size-1.5 rounded-full bg-emerald-500" /> Local data only
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto p-3">
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
                <div className="shrink-0 border-t p-4 text-xs text-muted-foreground">Chat history and app records stay on this Mac.</div>
            </aside>

            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                {!connected && (
                    <div className="border-b bg-background p-4">
                        <Card className="mx-auto max-w-3xl shadow-none">
                            <CardHeader>
                                <CardTitle className="text-base">Connect OpenAI</CardTitle>
                                <CardDescription>Your key goes directly to the local engine. It is never stored in the app database or browser storage.</CardDescription>
                            </CardHeader>
                            <CardContent>
                                <form onSubmit={connectProvider} className="flex flex-col gap-2 sm:flex-row">
                                    <label htmlFor="openai-key" className="sr-only">OpenAI API key</label>
                                    <Input id="openai-key" type="password" autoComplete="off" placeholder="OpenAI API key" value={apiKey} onChange={event => setApiKey(event.target.value)} />
                                    <Button className="w-full sm:w-auto" type="submit" disabled={!apiKey.trim() || busy === 'provider'}>{busy === 'provider' ? 'Connecting…' : 'Connect'}</Button>
                                </form>
                            </CardContent>
                        </Card>
                    </div>
                )}
                {connected && <div className="border-b px-5 py-2 text-xs text-muted-foreground">OpenAI connected · Local engine</div>}
                {error && <div role="alert" className="border-b bg-destructive/10 px-5 py-2 text-sm text-destructive">{error}</div>}

                {selectedAgent ? (
                    <DesktopConversation
                        key={selectedAgent.id}
                        agent={selectedAgent}
                        sessionId={selectedSessionId}
                        sessions={sessions}
                        onSelectSession={setSelectedSessionId}
                        onSessionCreated={id => {
                            setSelectedSessionId(id)
                            void fetch(`/api/desktop/agents/${encodeURIComponent(selectedAgent.id)}/sessions`).then(response => json<{ sessions: DesktopSessionView[] }>(response)).then(body => setSessions(body.sessions)).catch(cause => setError(cause instanceof Error ? cause.message : 'Could not refresh conversations'))
                        }}
                    />
                ) : (
                    <div className="flex flex-1 items-center justify-center p-6">
                        <Card className="w-full max-w-xl shadow-none">
                            <CardHeader>
                                <CardTitle>{agents.length ? 'Select a coworker' : 'Create your first coworker'}</CardTitle>
                                <CardDescription>{connected ? 'Give your coworker a name and a task, then start a local conversation.' : 'Connect OpenAI above, then create a coworker.'}</CardDescription>
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
                                    <Button type="submit" disabled={!connected || !name.trim() || busy === 'agent'}>{busy === 'agent' ? 'Creating…' : 'Create coworker'}</Button>
                                </form>
                            </CardContent>
                        </Card>
                    </div>
                )}
            </section>
        </main>
    )
}
