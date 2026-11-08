'use client'
import { useRef, useState } from 'react'
import { desktopApiConnectionNameSchema, desktopApiConnectionSecretSchema, type DesktopApiConnectionView } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelScroller } from '@/components/ui/panel-list'
import { ModelBuckets } from '@/components/connections/ModelBuckets'
import { DetailBlock } from '@/components/connections/DetailBlock'
import { catalogFor } from '@/lib/engine/models'
import { PencilIcon, PlusIcon } from '@/lib/icons'
import { apiConnectionSummary, apiEndpointDisplay } from '@/lib/desktop/api-connections/presentation'
import { ApiConnectionsSession } from '@/lib/desktop/api-connections/session'
import { ApiDetailHeader } from './ApiConnectionBits'
import { ApiDeleteConnectionButton } from './ApiDeleteConnectionButton'

export function ApiConnectionDetail({ connection, session }: { connection: DesktopApiConnectionView; session: ApiConnectionsSession }) {
    const state = session.snapshot(), [editingName, setEditingName] = useState(false), [editingKey, setEditingKey] = useState(!connection.connected || connection.credentialRejected)
    const cancelledRename = useRef(false)
    const nameKey = `name:${connection.connectionId}`, keyKey = `key:${connection.connectionId}`, modelKey = `model:${connection.connectionId}`
    const name = session.draft(nameKey, { name: connection.name, revision: connection.revision })
    const credential = session.draft(keyKey, { revision: connection.revision })
    const custom = session.draft(modelKey, { revision: connection.revision })
    const busy = state.busy || !!state.uncertain
    const staleName = name.revision !== connection.revision, staleKey = credential.revision !== connection.revision, staleModel = custom.revision !== connection.revision
    const rename = async () => {
        if (cancelledRename.current || busy || staleName || name.name.trim() === connection.name || !desktopApiConnectionNameSchema.safeParse(name.name).success) return
        const result = await session.execute({ kind: 'rename', input: { requestId: crypto.randomUUID(), workspaceId: session.workspaceId, connectionId: connection.connectionId, expectedRevision: name.revision!, name: name.name.trim() } })
        if (result?.status === 'saved' && session.current() && session.snapshot().page.kind === 'detail') setEditingName(false)
    }
    const models = (next: string[], extras = connection.extraModels) => {
        if (busy) return
        void session.execute({ kind: 'models', input: { requestId: crypto.randomUUID(), workspaceId: session.workspaceId,
            connectionId: connection.connectionId, expectedRevision: connection.revision, models: next, extraModels: extras,
            expectedDefault: state.catalog?.default ?? null } })
    }
    return <div className="flex min-h-0 flex-1 flex-col">
        <ApiDetailHeader connection={connection} onBack={() => session.navigate({ kind: 'list' })}>
            {editingName ? <div className="min-w-0">
                <Input autoFocus aria-label="Connection name" maxLength={120} value={name.name} disabled={busy} className="h-7 text-sm"
                    onChange={event => session.changeDraft(nameKey, { name: event.target.value })} onBlur={() => { if (!cancelledRename.current) void rename() }}
                    onKeyDown={event => {
                        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void rename() }
                        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelledRename.current = true; setEditingName(false) }
                    }} />
                {staleName && <p role="alert" className="text-[11px] text-destructive">The saved connection changed. Your draft is kept. <button type="button" onClick={() => session.resetDraft(nameKey)} className="underline">Use saved name</button></p>}
            </div> : <button type="button" disabled={busy} className="group/name inline-flex min-w-0 items-center gap-1.5 text-left" onClick={() => { cancelledRename.current = false; setEditingName(true) }}>
                <span className="truncate text-sm font-medium">{connection.name}</span><PencilIcon className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover/name:opacity-100 group-focus-visible/name:opacity-100 [@media(hover:none)]:opacity-100" />
            </button>}
        </ApiDetailHeader>
        <PanelScroller className="space-y-5 p-4">
            <fieldset disabled={busy} className="min-w-0 space-y-5">
                {(connection.credentialRejected || !connection.connected) && <div className="rounded-md border border-orange-500/30 bg-orange-500/5 px-3 py-2.5 text-xs">
                    {connection.credentialRejected ? 'This key was rejected. Coworkers using it are stopped until you paste a new one.' : 'No key on file. Coworkers using it are stopped until you paste one.'}
                </div>}
                <DetailBlock title={connection.connected ? 'Replacement API key' : 'API key'} aside={!editingKey && <Button type="button" size="xs" variant="outline" onClick={() => setEditingKey(true)}>{connection.connected ? 'Replace key' : 'Add key'}</Button>}>
                    {editingKey ? <form className="space-y-2" onSubmit={event => {
                        event.preventDefault()
                        if (staleKey || !desktopApiConnectionSecretSchema.safeParse(credential.secret).success) return
                        void session.execute({ kind: 'credential', input: { requestId: crypto.randomUUID(), workspaceId: session.workspaceId, connectionId: connection.connectionId, expectedRevision: credential.revision!, secret: credential.secret.trim() } })
                    }}>
                        <div className="flex flex-wrap items-center gap-2">
                            <Input hideRequired aria-label="Replacement API key" type="password" autoComplete="new-password" spellCheck={false} maxLength={4096} value={credential.secret} placeholder="Paste your key" className="h-8 min-w-0 flex-1 font-mono text-xs" onChange={event => session.changeDraft(keyKey, { secret: event.target.value })} />
                            <Button type="button" size="sm" variant="ghost" onClick={() => setEditingKey(false)}>Cancel</Button>
                            <Button type="submit" size="sm" disabled={staleKey || !credential.secret.trim()}>Save</Button>
                        </div>
                        {staleKey && <p role="alert" className="text-[11px] text-destructive">The saved connection changed. Your replacement is kept. <button type="button" className="underline" onClick={() => session.reviewDraftRevision(keyKey, connection)}>Use the current connection revision</button> before saving.</p>}
                    </form> : <p className="text-[11px] text-muted-foreground">Saved keys are never shown. Replacing a key does not test the provider.</p>}
                </DetailBlock>
                <div inert={busy}><ModelBuckets connection={apiConnectionSummary(connection)} defaultModel={state.catalog?.default?.connectionId === connection.connectionId ? state.catalog.default.model : null} onModelsChange={next => models(next)} /></div>
                {connection.provider === 'openrouter' && <DetailBlock title="Custom models">
                    <div className="space-y-2 border-t pt-3">
                        {connection.extraModels.map(id => <div key={id} className="flex items-center justify-between gap-2 py-1.5"><span className="truncate font-mono text-xs">{id}</span><Button type="button" size="xs" variant="ghost" disabled={state.catalog?.default?.connectionId === connection.connectionId && state.catalog.default.model === id} onClick={() => models(connection.models, connection.extraModels.filter(model => model !== id))}>Remove</Button></div>)}
                        <p className="text-[11px] text-muted-foreground">Add any OpenRouter model id (e.g. <span className="font-mono">x-ai/grok-4</span>).</p>
                        <form className="flex flex-wrap items-center gap-2" onSubmit={event => {
                            event.preventDefault()
                            const id = custom.modelId.trim()
                            if (!staleModel && id && id.length <= 300 && connection.extraModels.length < 256 && ![...catalogFor(connection.provider).models.map(model => model.id), ...connection.extraModels].includes(id)) models(connection.models, [...connection.extraModels, id])
                        }}>
                            <Input hideRequired aria-label="Custom model ID" placeholder="vendor/model" className="h-8 min-w-0 flex-1 font-mono text-xs" maxLength={300} value={custom.modelId} onChange={event => session.changeDraft(modelKey, { modelId: event.target.value })} />
                            <Button type="submit" size="sm" variant="outline" disabled={staleModel || !custom.modelId.trim()}><PlusIcon className="size-3" />Add</Button>
                        </form>
                        {staleModel && <p role="alert" className="text-[11px] text-destructive">The saved models changed. Your model ID is kept. <button type="button" className="underline" onClick={() => session.resetDraft(modelKey)}>Use saved models</button></p>}
                    </div>
                </DetailBlock>}
                {connection.baseUrl && <DetailBlock title="Base URL"><p className="break-all font-mono text-xs text-muted-foreground">{apiEndpointDisplay(connection.baseUrl)}</p><p className="text-[11px] text-muted-foreground">Endpoint editing is unavailable in this flow.</p></DetailBlock>}
            </fieldset>
        </PanelScroller>
        <div className="shrink-0 border-t p-3"><ApiDeleteConnectionButton key={connection.connectionId + ':' + connection.revision} connection={connection} session={session} /></div>
    </div>
}
