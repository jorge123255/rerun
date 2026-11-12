'use client'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
    DESKTOP_API_CONNECTION_PROVIDERS, desktopApiConnectionProviderSchema,
    type DesktopApiConnectionCatalog, type DesktopWorkspaceId,
} from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { PanelScroller } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSteps } from '@/components/ui/panel-steps'
import { ProviderPicker } from '@/components/connections/ProviderPicker'
import { SourceAvatar } from '@/components/connections/SourceBits'
import { PROVIDER_PITCH } from '@/lib/engine/ai-sources'
import { catalogFor } from '@/lib/engine/models'
import { ChevronRightIcon, PlusIcon } from '@/lib/icons'
import type { ApiConnectionsApi } from '@/lib/desktop/api-connections/client'
import { ApiConnectionsSession, type ApiSelectionContext } from '@/lib/desktop/api-connections/session'
import { ApiConnectionStatus } from './ApiConnectionBits'
import { ApiAddProviderPage } from './ApiAddProviderPage'
import { ApiConnectionDetail } from './ApiConnectionDetail'

export type ApiConnectionsPanelProps = {
    workspaceId: DesktopWorkspaceId
    currentWorkspace(): DesktopWorkspaceId | null
    active: boolean
    api: ApiConnectionsApi | null
    selectionContext: ApiSelectionContext | null
    initialConnectionId?: string
    onCatalog?(catalog: DesktopApiConnectionCatalog): void
}
export function ApiConnectionsPanel(props: ApiConnectionsPanelProps) {
    return <WorkspacePanel key={JSON.stringify([props.workspaceId, props.initialConnectionId ?? null])} {...props} />
}
function WorkspacePanel(props: ApiConnectionsPanelProps) {
    const latest = useRef(props); latest.current = props
    const [session, setSession] = useState<ApiConnectionsSession | null>(null)
    useEffect(() => {
        if (!props.api) { setSession(null); return }
        const owned = new ApiConnectionsSession(props.workspaceId, props.api, () => latest.current.active ? latest.current.currentWorkspace() : null,
            props.initialConnectionId ? { kind: 'detail', connectionId: props.initialConnectionId } : undefined)
        setSession(owned)
        return () => owned.close()
    }, [props.workspaceId, props.api, props.initialConnectionId])
    useEffect(() => { if (session) { if (props.active) void session.refresh(); else session.suspend() } }, [session, props.active])
    if (!props.active) return null
    if (!props.api) return <p role="status" className="p-4 text-xs text-muted-foreground">API connections are unavailable until the local connection service is connected.</p>
    if (!session || !session.current()) return <p role="status" className="p-4 text-xs text-muted-foreground">Loading connections…</p>
    return <SessionPanel session={session} selectionContext={props.selectionContext} onCatalog={catalog => { if (session.current()) latest.current.onCatalog?.(catalog) }} />
}
function SessionPanel({ session, selectionContext, onCatalog }: { session: ApiConnectionsSession; selectionContext: ApiSelectionContext | null; onCatalog(catalog: DesktopApiConnectionCatalog): void }) {
    const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot), { page, catalog } = state
    const callback = useRef(onCatalog); callback.current = onCatalog
    useEffect(() => { if (catalog && session.current()) callback.current(catalog) }, [catalog, session])
    const selected = page.kind === 'detail' ? session.connection(page.connectionId) : null
    const stepKey = page.kind === 'list' ? 'list' : page.kind === 'add' ? `add:${page.provider}` : `detail:${page.connectionId}`
    const disabled = state.busy || !!state.uncertain
    return <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Your API keys" aria-busy={state.busy || state.loading}>
        {(state.error || state.notice || state.uncertain) && <div className="shrink-0 space-y-2 border-b p-3 text-xs">
            {state.error && <p role="alert" className="break-words text-destructive">{state.error}</p>}
            {state.notice && <p role="status" className="break-words text-muted-foreground">{state.notice}</p>}
            {state.uncertain && <div className="flex flex-wrap items-center gap-2"><p className="min-w-0 break-all text-muted-foreground">Request {state.uncertain.requestId}</p><Button type="button" size="sm" variant="outline" disabled={state.busy} onClick={() => void session.retry()}>Retry same request</Button></div>}
        </div>}
        <PanelSteps stepKey={stepKey} depth={page.kind === 'list' ? 0 : 1}>
            {page.kind === 'add' ? <ApiAddProviderPage provider={page.provider} session={session} />
                : selected ? <ApiConnectionDetail key={selected.connectionId} connection={selected} session={session} />
                    : page.kind === 'detail' ? <div className="space-y-2 p-4">
                        <p role="status" className="text-xs">{!catalog && !state.error ? 'Loading connection…' : 'This connection is unavailable.'}</p>
                        {state.error && <Button type="button" size="sm" variant="outline" onClick={() => void session.refresh()}>Reload connection</Button>}
                        <Button type="button" size="sm" variant="outline" onClick={() => session.navigate({ kind: 'list' })}>Back to connection list</Button>
                    </div>
                        : <PanelScroller className="space-y-6 p-4">
                            {!catalog && state.loading ? <div role="status" className="space-y-3">{[0, 1, 2].map(index => <div key={index} className="h-14 animate-pulse rounded-md border bg-muted/30" />)}<span className="sr-only">Loading connections…</span></div>
                                : catalog ? <>
                                    <DefaultModel session={session} selectionContext={selectionContext} />
                                    <section className="space-y-2">
                                        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium text-muted-foreground">Your API keys</h3>
                                            {catalog.connections.length > 0 && <ProviderPicker only="key" taken={new Set(catalog.connections.map(c => c.provider))} onPick={provider => { const parsed = desktopApiConnectionProviderSchema.safeParse(provider); if (parsed.success) session.navigate({ kind: 'add', provider: parsed.data }) }}><Button type="button" size="xs" variant="secondary" disabled={disabled}><PlusIcon className="size-3" />Add API key</Button></ProviderPicker>}
                                        </div>
                                        <div className="space-y-1.5">{catalog.connections.map(connection => <PanelRow key={connection.connectionId} onClick={disabled ? undefined : () => session.navigate({ kind: 'detail', connectionId: connection.connectionId })}
                                            leading={<SourceAvatar provider={connection.provider} />} title={connection.name}
                                            description={`${PROVIDER_PITCH[connection.provider].title} API key · ${connection.models.length + connection.extraModels.length} models`}
                                            actions={<><ApiConnectionStatus connection={connection} /><ChevronRightIcon className="ml-1 size-4 text-muted-foreground" /></>} />)}</div>
                                        {catalog.connections.length === 0 && <div className="flex flex-col items-center gap-3 rounded-md border border-dashed px-3 py-5 text-center">
                                            <span className="text-xs text-muted-foreground">Pay your provider directly, per token.</span>
                                            <div className="flex flex-wrap items-center justify-center gap-2">{DESKTOP_API_CONNECTION_PROVIDERS.map(provider => <Button type="button" key={provider} variant="outline" disabled={disabled} onClick={() => session.navigate({ kind: 'add', provider })}><SourceAvatar provider={provider} size="sm" />{PROVIDER_PITCH[provider].title}</Button>)}</div>
                                        </div>}
                                    </section>
                                </> : <p role="status" className="text-xs text-muted-foreground">The saved connection list is unavailable.</p>}
                            <Button type="button" size="sm" variant="ghost" disabled={state.loading || state.busy} onClick={() => void session.refresh()}>{state.loading ? 'Loading…' : 'Reload connections'}</Button>
                        </PanelScroller>}
        </PanelSteps>
    </section>
}
function DefaultModel({ session, selectionContext }: { session: ApiConnectionsSession; selectionContext: ApiSelectionContext | null }) {
    const state = session.snapshot(), catalog = state.catalog!
    const choices = catalog.connections.filter(c => c.connected && !c.credentialRejected).flatMap(c => [...new Set([...c.models, ...c.extraModels])].map(model => ({ connectionId: c.connectionId, model, revision: c.revision })))
    const selected = choices.findIndex(p => p.connectionId === catalog.default?.connectionId && p.model === catalog.default.model)
    const external = catalog.default && !catalog.connections.some(c => c.connectionId === catalog.default!.connectionId)
    return <section className="space-y-2"><h3 className="text-sm font-medium text-muted-foreground">Default model</h3>
        <div className="space-y-2 rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Coworkers with no model of their own run on it.</p>
            <select aria-label="Default model" className="h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs" value={selected} disabled={state.busy || !!state.uncertain || !selectionContext || !choices.length} onChange={event => {
                const pick = choices[Number(event.target.value)]
                if (!pick || !selectionContext) return
                void session.execute({ kind: 'select', input: { requestId: crypto.randomUUID(), workspaceId: session.workspaceId,
                    connectionId: pick.connectionId, expectedRevision: pick.revision, model: pick.model, ...selectionContext } })
            }}>
                {selected < 0 && <option value={-1} disabled>{external ? `Current connection: ${catalog.default!.connectionId} · ${catalog.default!.model}` : catalog.default ? `${catalog.default.model} (unavailable)` : 'Choose a model'}</option>}
                {catalog.connections.filter(c => c.connected && !c.credentialRejected).map(connection => <optgroup key={connection.connectionId} label={connection.name}>{choices.map((pick, index) => pick.connectionId === connection.connectionId && <option key={pick.model} value={index}>{catalogFor(connection.provider).models.find(model => model.id === pick.model)?.label ?? pick.model}</option>)}</optgroup>)}
            </select>
            {!selectionContext && <p role="status" className="text-[11px] text-muted-foreground">Model selection is unavailable until the current local selection authority is connected.</p>}
        </div>
    </section>
}
