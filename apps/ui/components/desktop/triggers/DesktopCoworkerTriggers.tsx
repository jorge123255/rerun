'use client'

import { DesktopTriggerEditor } from '@/components/desktop/triggers/DesktopTriggerEditor'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelList, PanelListHeader, PanelScroller } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSteps } from '@/components/ui/panel-steps'
import { SkeletonPanelRows } from '@/components/ui/skeleton'
import { Badge } from '@rerun/ui/primitives'
import { PauseIcon, PlusIcon, WebhookIcon, ArrowLeftIcon, Loader2Icon } from '@/lib/icons'
import { DesktopTaskOutcomeFooter } from '@/components/desktop/triggers/DesktopTaskOutcomeFooter'
import {
    listDesktopTriggers,
    listDesktopTriggerHistory,
    latestTriggerOutcomes,
    triggerOutcomeKey,
    TriggerRequestError,
    unavailableTriggerRunModelCatalog,
    desktopTriggerPromptLock,
    type DesktopTriggerOutcome,
    type DesktopTriggerRunModelCatalog,
    type DesktopTriggerTemplateLockState,
} from '@/lib/desktop/triggers'
import type { DesktopTrigger, DesktopTriggerHistoryItem } from '@rerun/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { RunStatusBadge } from '@rerun/ui/monitoring'

type ChatOpen = { sessionId: string; title: string; runId: string | null }

type View = { mode: 'list' } | { mode: 'create' } | { mode: 'edit'; slug: string } | { mode: 'runs'; slug: string }

function triggerSummary(t: DesktopTrigger): string {
    const calls = t.fireCount === 1 ? '1 call' : `${t.fireCount} calls`
    return `${t.methods.join('/')} · ${calls}`
}

export function DesktopCoworkerTriggers({
    agentId,
    onOpenSession,
    onEditStateChange,
    ingressAvailable = false,
    modelCatalog = unavailableTriggerRunModelCatalog(),
    templateLock = desktopTriggerPromptLock(false),
}: {
    agentId: string
    onOpenSession: (chat: ChatOpen) => void
    onEditStateChange?: (state: { dirty: boolean; busy: boolean }) => void
    ingressAvailable?: boolean
    modelCatalog?: DesktopTriggerRunModelCatalog
    templateLock?: DesktopTriggerTemplateLockState
}) {
    return (
        <Triggers
            key={agentId}
            agentId={agentId}
            onOpenSession={onOpenSession}
            onEditStateChange={onEditStateChange}
            ingressAvailable={ingressAvailable}
            modelCatalog={modelCatalog}
            templateLock={templateLock}
        />
    )
}

function Triggers({
    agentId,
    onOpenSession,
    onEditStateChange,
    ingressAvailable,
    modelCatalog,
    templateLock,
}: {
    agentId: string
    onOpenSession: (chat: ChatOpen) => void
    onEditStateChange?: (state: { dirty: boolean; busy: boolean }) => void
    ingressAvailable: boolean
    modelCatalog: DesktopTriggerRunModelCatalog
    templateLock: DesktopTriggerTemplateLockState
}) {
    const [triggers, setTriggers] = useState<DesktopTrigger[] | null>(null)
    const [outcomes, setOutcomes] = useState<Record<string, DesktopTriggerOutcome>>({})
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [view, setView] = useState<View>({ mode: 'list' })
    const alive = useRef(true)
    const listEpoch = useRef(0)
    const agentEpoch = useRef(agentId)

    useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
    }, [])

    useEffect(() => {
        if (agentEpoch.current !== agentId) {
            agentEpoch.current = agentId
            setView({ mode: 'list' })
            setTriggers(null)
            setOutcomes({})
            setError('')
        }
    }, [agentId])

    const load = useCallback(async () => {
        const own = ++listEpoch.current
        setLoading(true)
        try {
            const next = await listDesktopTriggers(agentId)
            let nextOutcomes: Record<string, DesktopTriggerOutcome> = {}
            try {
                const history = await listDesktopTriggerHistory(agentId)
                nextOutcomes = latestTriggerOutcomes(history)
            } catch {
                // Outcomes stay empty rather than inventing Done/Failed from incomplete data.
                nextOutcomes = {}
            }
            if (alive.current && own === listEpoch.current && agentEpoch.current === agentId) {
                setTriggers(next)
                setOutcomes(nextOutcomes)
                setError('')
            }
        } catch (err) {
            if (alive.current && own === listEpoch.current && agentEpoch.current === agentId) {
                setError(err instanceof TriggerRequestError ? err.message : 'Could not load triggers')
            }
        } finally {
            if (alive.current && own === listEpoch.current && agentEpoch.current === agentId) setLoading(false)
        }
    }, [agentId])

    useEffect(() => { void load() }, [load])

    const stepKey = view.mode === 'edit' || view.mode === 'runs' ? `${view.mode}:${view.slug}` : view.mode
    const stepDepth = view.mode === 'list' ? 0 : view.mode === 'runs' ? 2 : 1

    if (view.mode === 'create') {
        return (
            <PanelSteps stepKey={stepKey} depth={stepDepth}>
                <DesktopTriggerEditor
                    onEditStateChange={onEditStateChange}
                    agentId={agentId}
                    ingressAvailable={ingressAvailable}
                    modelCatalog={modelCatalog}
                    templateLock={templateLock}
                    onDone={() => { setView({ mode: 'list' }); void load() }}
                    onBack={() => setView({ mode: 'list' })}
                />
            </PanelSteps>
        )
    }

    if (view.mode === 'edit') {
        return (
            <PanelSteps stepKey={stepKey} depth={stepDepth}>
                <DesktopTriggerEditor
                    onEditStateChange={onEditStateChange}
                    agentId={agentId}
                    slug={view.slug}
                    ingressAvailable={ingressAvailable}
                    modelCatalog={modelCatalog}
                    templateLock={templateLock}
                    onDone={() => { setView({ mode: 'list' }); void load() }}
                    onBack={() => setView({ mode: 'list' })}
                    onShowHistory={() => setView({ mode: 'runs', slug: view.slug })}
                />
            </PanelSteps>
        )
    }

    if (view.mode === 'runs') {
        return (
            <PanelSteps stepKey={stepKey} depth={stepDepth}>
                <TriggerRuns
                    agentId={agentId}
                    slug={view.slug}
                    title={triggers?.find(t => t.slug === view.slug)?.name ?? view.slug}
                    onBack={() => setView({ mode: 'edit', slug: view.slug })}
                    onOpenSession={onOpenSession}
                />
            </PanelSteps>
        )
    }

    const newButton = (
        <Button size="sm" variant="outline" disabled={loading || Boolean(error)} onClick={() => setView({ mode: 'create' })}>
            <PlusIcon className="size-3.5 mr-1" /> New
        </Button>
    )

    return (
        <PanelSteps stepKey={stepKey} depth={stepDepth}>
            <div className="flex h-full min-h-0 flex-col">
                <PanelListHeader count={triggers?.length ?? 0} noun="trigger">{newButton}</PanelListHeader>
                {error && <p role="alert" className="p-3 text-xs text-destructive">{error}</p>}
                {loading && <SkeletonPanelRows rows={5} lines={3} badge />}
                {!loading && !error && triggers?.length === 0 ? (
                    <EmptyState
                        icon={WebhookIcon}
                        title="No triggers yet"
                        description="A trigger gives your coworker a local webhook URL. When a program on this Mac calls it, the coworker runs with the payload it received."
                        action={newButton}
                    />
                ) : null}
                {!loading && triggers && triggers.length > 0 ? (
                    <PanelScroller>
                        <PanelList>
                            {triggers.map(t => (
                                <PanelRow
                                    key={t.slug}
                                    onClick={() => setView({ mode: 'edit', slug: t.slug })}
                                    title={t.name}
                                    description={triggerSummary(t)}
                                    footer={
                                        <DesktopTaskOutcomeFooter
                                            outcome={outcomes[triggerOutcomeKey(t.slug)]}
                                            lastStartedAt={t.lastFiredAt}
                                            onOpenChat={(sessionId, runId) => onOpenSession({ sessionId, title: t.name, runId })}
                                        />
                                    }
                                    meta={!t.enabled ? (
                                        <Badge size="xs" tone="neutral" glow={false} leading={<PauseIcon className="size-3" />}>paused</Badge>
                                    ) : undefined}
                                />
                            ))}
                        </PanelList>
                    </PanelScroller>
                ) : null}
                <p className="p-3 text-xs text-muted-foreground">
                    Webhook URLs work only on this Mac. Copying or previewing a URL never starts a run. Disabled or deleted triggers keep their history.
                </p>
                <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>Refresh</Button>
            </div>
        </PanelSteps>
    )
}

function TriggerRuns({
    agentId,
    slug,
    title,
    onBack,
    onOpenSession,
}: {
    agentId: string
    slug: string
    title: string
    onBack: () => void
    onOpenSession: (chat: ChatOpen) => void
}) {
    const [items, setItems] = useState<DesktopTriggerHistoryItem[]>([])
    const [loading, setLoading] = useState(true)
    const [opening, setOpening] = useState<string | null>(null)
    const [error, setError] = useState('')
    const alive = useRef(true)
    const generation = useRef(0)

    useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
    }, [])

    const load = useCallback(async () => {
        const own = ++generation.current
        setLoading(true)
        try {
            const next = await listDesktopTriggerHistory(agentId, slug)
            if (alive.current && own === generation.current) { setItems(next); setError('') }
        } catch (err) {
            if (alive.current && own === generation.current) setError(err instanceof TriggerRequestError ? err.message : 'Could not load history')
        } finally {
            if (alive.current && own === generation.current) setLoading(false)
        }
    }, [agentId, slug])

    useEffect(() => { void load(); return () => { generation.current++ } }, [load])

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <Button size="icon-sm" variant="ghost" onClick={onBack}><ArrowLeftIcon className="size-4" /></Button>
                <span className="truncate text-sm font-medium">{title}</span>
            </div>
            {error && <p role="alert" className="p-3 text-xs text-destructive">{error}</p>}
            {loading ? <SkeletonPanelRows rows={5} badge /> : items.length === 0 ? (
                <EmptyState className="h-full" icon={WebhookIcon} title="Never called yet" />
            ) : (
                <PanelScroller>
                    <PanelList>
                        {items.map(item => (
                            <PanelRow
                                key={item.eventId}
                                disabled={opening !== null || !item.localSessionId}
                                onClick={async () => {
                                    if (!item.localSessionId) return
                                    setOpening(item.eventId)
                                    try {
                                        onOpenSession({ sessionId: item.localSessionId, title, runId: item.status === 'running' ? item.runId : null })
                                    } finally {
                                        if (alive.current) setOpening(null)
                                    }
                                }}
                                title={new Date(item.receivedAt).toLocaleString()}
                                description={[item.capturedPayload ? 'captured payload' : 'live-only', item.error].filter(Boolean).join(' · ')}
                                meta={opening === item.eventId ? <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" /> : item.status === 'needs-input'
                                    ? <Badge size="xs" tone="orange" glow={false}>Needs input</Badge>
                                    : <RunStatusBadge status={item.status === 'finished' ? 'done' : item.status === 'accepted' ? 'running' : item.status === 'refused' || item.status === 'uncertain' ? 'error' : item.status} />}
                            />
                        ))}
                    </PanelList>
                </PanelScroller>
            )}
        </div>
    )
}
