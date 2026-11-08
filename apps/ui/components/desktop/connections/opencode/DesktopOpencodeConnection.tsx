'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { DetailBlock } from '@/components/connections/DetailBlock'
import { SourceAvatar } from '@/components/connections/SourceBits'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { CredentialGuide } from '@/components/services/CredentialGuide'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelScroller } from '@/components/ui/panel-list'
import { SkeletonList } from '@/components/ui/skeleton'
import { ChevronLeftIcon, PencilIcon } from '@/lib/icons'
import { createDesktopOpencodeDriver } from '@/lib/desktop/opencode/client'
import type { DesktopOpencodeConnectionSnapshot, DesktopOpencodeDriver, DesktopOpencodeSettingsChange } from '@/lib/desktop/opencode/driver'
import { Badge } from '@rerun/ui/primitives'
import { DESKTOP_OPENCODE_DEFAULT_MODEL, DESKTOP_OPENCODE_SNAPSHOT, type DesktopOpencodeRefresh, type DesktopOpencodeWindow } from '@rerun/contracts'
import { DesktopOpencodeModels, type DesktopOpencodeModelsChange } from './DesktopOpencodeModels'
import { DesktopOpencodePlanLimits } from './DesktopOpencodePlanLimits'

const snapshotCatalog = (workspaceId: number, selectedModelId = DESKTOP_OPENCODE_DEFAULT_MODEL): DesktopOpencodeRefresh => ({
    workspaceId, requestId: 'snapshot', revision: 'snapshot', source: 'snapshot', fresh: false, capturedAt: null, selectedModelId,
    selectedPreserved: DESKTOP_OPENCODE_SNAPSHOT.some(model => model.id === selectedModelId), retiredModelIds: [], models: DESKTOP_OPENCODE_SNAPSHOT,
})
const emptyUsage: { windows: DesktopOpencodeWindow[]; capturedAt: string | null; fresh: boolean } = { windows: [], capturedAt: null, fresh: false }

export function DesktopOpencodeConnection({ workspaceId, connection, driver: suppliedDriver, rejected = false, onSave, onProviders, onRename, onDisconnect, onBack, onConnected }: {
    workspaceId: number
    connection: DesktopOpencodeConnectionSnapshot | null
    driver?: DesktopOpencodeDriver
    rejected?: boolean
    onSave: (change: DesktopOpencodeSettingsChange) => Promise<void>
    onProviders: () => void | Promise<void>
    onRename: (connectionId: string, name: string, expectedConnectionRevision: string) => Promise<void>
    onDisconnect: (connectionId: string, expectedConnectionRevision: string) => Promise<void>
    onBack: () => void
    onConnected?: () => void
}) {
    const credentialFieldsId = useId()
    const driver = useRef(suppliedDriver ?? createDesktopOpencodeDriver()).current
    const [catalog, setCatalog] = useState<DesktopOpencodeRefresh>(() => snapshotCatalog(workspaceId, connection?.defaultModelId))
    const [usage, setUsage] = useState(emptyUsage)
    const [loading, setLoading] = useState(!!connection)
    const [refreshingModels, setRefreshingModels] = useState(false)
    const [refreshingUsage, setRefreshingUsage] = useState(false)
    const [saving, setSaving] = useState(false)
    const [apiKey, setApiKey] = useState('')
    const [name, setName] = useState(connection?.owner ?? 'OpenCode')
    const [editingName, setEditingName] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [discardOpen, setDiscardOpen] = useState(false)
    const [disconnectOpen, setDisconnectOpen] = useState(false)
    const generation = useRef(0)
    const reads = useRef<AbortController | null>(null)
    const refreshModelId = useRef<string | null>(null)
    const refreshUsageId = useRef<string | null>(null)
    const cancelling = useRef(false)
    const current = useCallback((value: number) => generation.current === value, [])

    async function refreshProviders(value: number) {
        try { await onProviders() }
        catch { if (current(value)) setError('Saved. Refresh the provider list to confirm the current connection.') }
    }

    useEffect(() => {
        generation.current += 1
        const value = generation.current
        reads.current?.abort()
        const controller = new AbortController()
        reads.current = controller
        refreshModelId.current = null
        refreshUsageId.current = null
        setName(connection?.owner ?? 'OpenCode')
        setCatalog(snapshotCatalog(workspaceId, connection?.defaultModelId))
        setUsage(emptyUsage)
        setError(null)
        setNotice(null)
        if (!connection) { setLoading(false); return () => controller.abort() }
        setLoading(true)
        void Promise.all([
            driver.catalog({ workspaceId, connectionId: connection.connectionId, requestId: 'catalog-read', selectedModelId: connection.defaultModelId }, controller.signal),
            driver.usage({ workspaceId, connectionId: connection.connectionId, requestId: 'usage-read', refresh: false }, controller.signal),
        ]).then(([nextCatalog, nextUsage]) => {
            if (!current(value) || controller.signal.aborted) return
            setCatalog(nextCatalog)
            setUsage(nextUsage)
        }).catch(cause => {
            if (current(value) && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load OpenCode.')
        }).finally(() => { if (current(value)) setLoading(false) })
        return () => { controller.abort() }
    }, [connection?.connectionId, connection?.connectionRevision, workspaceId, driver, current])

    useEffect(() => () => { generation.current += 1; reads.current?.abort() }, [])

    const refreshModels = async () => {
        if (!connection || refreshingModels) return
        const value = generation.current
        refreshModelId.current ??= crypto.randomUUID()
        setRefreshingModels(true)
        setError(null)
        try {
            const next = await driver.refresh({ workspaceId, connectionId: connection.connectionId, requestId: refreshModelId.current, selectedModelId: connection.defaultModelId }, reads.current?.signal ?? new AbortController().signal)
            if (current(value)) { setCatalog(next); setNotice(next.fresh ? 'Model catalog refreshed.' : 'Model catalog updated from cached data.') }
        } catch (cause) {
            if (current(value)) setError(cause instanceof Error ? cause.message : 'Could not refresh models.')
        } finally {
            if (current(value)) setRefreshingModels(false)
        }
    }

    const refreshUsage = async () => {
        if (!connection || refreshingUsage) return
        const value = generation.current
        refreshUsageId.current ??= crypto.randomUUID()
        setRefreshingUsage(true)
        setError(null)
        try {
            const next = await driver.usage({ workspaceId, connectionId: connection.connectionId, requestId: refreshUsageId.current, refresh: true }, reads.current?.signal ?? new AbortController().signal)
            if (current(value)) setUsage(next)
        } catch (cause) {
            if (current(value)) setError(cause instanceof Error ? cause.message : 'Could not refresh plan usage.')
        } finally {
            if (current(value)) setRefreshingUsage(false)
        }
    }

    const saveKey = async () => {
        const trimmed = apiKey.trim()
        if (!trimmed || saving) return
        const value = generation.current
        setSaving(true)
        setError(null)
        setNotice(null)
        try {
            const prepared = await driver.prepare(trimmed, reads.current?.signal ?? new AbortController().signal)
            if (!current(value)) return
            if (!prepared.ok) { setError(prepared.problem); return }
            await onSave({ action: 'key', provider: 'opencode', ...(connection ? { connectionId: connection.connectionId, expectedConnectionRevision: connection.connectionRevision } : {}), apiKey: trimmed })
            if (!current(value)) return
            setApiKey('')
            setNotice(connection ? 'API key saved.' : 'OpenCode connected.')
            onConnected?.()
            await refreshProviders(value)
        } catch (cause) {
            if (current(value)) setError(cause instanceof Error ? cause.message : 'Could not save the OpenCode key.')
        } finally {
            if (current(value)) setSaving(false)
        }
    }

    const saveName = async () => {
        if (cancelling.current) return
        const trimmed = name.trim()
        if (!connection || !trimmed || trimmed === connection.owner || saving) { setEditingName(false); return }
        const value = generation.current
        setSaving(true)
        setError(null)
        try {
            await onRename(connection.connectionId, trimmed, connection.connectionRevision)
            if (!current(value)) return
            setNotice('Connection name saved.')
            setEditingName(false)
            await refreshProviders(value)
        } catch (cause) {
            if (current(value)) setError(cause instanceof Error ? cause.message : 'Could not rename the connection.')
        } finally {
            if (current(value)) setSaving(false)
        }
    }

    const saveModels = async (change: DesktopOpencodeModelsChange) => {
        if (!connection || saving) return
        const value = generation.current
        setSaving(true)
        setError(null)
        setNotice(null)
        try {
            const checked = await driver.enable({ workspaceId, connectionId: connection.connectionId, defaultModelId: connection.defaultModelId, ...change }, reads.current?.signal ?? new AbortController().signal)
            if (!current(value)) return
            if (!checked.ok) { setError(checked.problem); return }
            await onSave({ action: 'models', connectionId: connection.connectionId, models: change.enabledModelIds, extraModels: [], expectedConnectionRevision: connection.connectionRevision })
            if (!current(value)) return
            setNotice('Available models updated.')
            await refreshProviders(value)
        } catch (cause) {
            if (current(value)) setError(cause instanceof Error ? cause.message : 'Could not update available models.')
        } finally {
            if (current(value)) setSaving(false)
        }
    }

    const remove = async () => {
        if (!connection || saving) return
        const value = generation.current
        setSaving(true)
        setError(null)
        try {
            await onDisconnect(connection.connectionId, connection.connectionRevision)
            if (current(value)) onBack()
        } catch (cause) {
            if (current(value)) setError(cause instanceof Error ? cause.message : 'Could not disconnect OpenCode.')
        } finally {
            if (current(value)) setSaving(false)
        }
    }

    const dirty = !!apiKey.trim() || name.trim() !== (connection?.owner ?? 'OpenCode')
    const back = () => { cancelling.current = true; if (dirty) setDiscardOpen(true); else onBack() }
    const connected = !!connection && connection.state === 'active' && !!connection.apiKey && !rejected

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-3 border-b px-3 py-2.5">
                <Button type="button" aria-label="Back to AI providers" variant="ghost" size="icon-sm" className="shrink-0" onClick={back}><ChevronLeftIcon className="size-4" /></Button>
                <SourceAvatar provider="opencode" size="sm" />
                <div className="flex min-w-0 flex-1 flex-col">
                    {editingName && connection ? (
                        <Input autoFocus aria-label="Connection name" value={name} onChange={event => setName(event.target.value)} onBlur={() => void saveName()} onKeyDown={event => {
                            if (event.key === 'Enter') void saveName()
                            if (event.key === 'Escape') { setName(connection.owner); setEditingName(false) }
                        }} className="h-7 text-sm" />
                    ) : (
                        <button type="button" onClick={() => { if (connection) setEditingName(true) }} className="group/name inline-flex min-w-0 items-center gap-1.5 text-left">
                            <span className="truncate text-sm font-medium">{name}</span>
                            {connection && <PencilIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/name:opacity-100" />}
                        </button>
                    )}
                    <span className="truncate text-[11px] text-muted-foreground">OpenCode Go or Console</span>
                </div>
                <Badge size="xs" tone={connected ? 'green' : 'orange'} className="shrink-0">{connected ? 'Ready' : rejected ? 'Key rejected' : 'Key missing'}</Badge>
            </div>
            <PanelScroller className="space-y-5 p-4">
                {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
                {notice && <p role="status" className="text-[11px] text-muted-foreground">{notice}</p>}
                <DetailBlock title="OpenCode credential">
                    <p className="text-[11px] text-muted-foreground">
                        {rejected ? 'This key was rejected. Coworkers using it are stopped until you paste a new one.' : connection?.apiKey ? 'Key saved. Paste a replacement only when you want to change it.' : 'No key on file. Coworkers using it are stopped until you paste one.'}
                    </p>
                    <Input id={`${credentialFieldsId}-name`} hideRequired label="Name" value={name} onChange={event => setName(event.target.value)} disabled={saving} className="h-8" />
                    <Input id={`${credentialFieldsId}-api-key`} hideRequired label="API key" type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="Paste your key" disabled={saving} className="h-8 font-mono text-xs" />
                    <CredentialGuide label="OpenCode Go or Console" title="How to get your OpenCode key" guide={'1. Open [OpenCode](https://opencode.ai/auth) and sign in.\n2. Subscribe to **OpenCode Go**, or add credits to use the Console models.\n3. Create an API key, copy it (it starts with `oc_sk_`) and paste it above.'} />
                    <div className="flex justify-end"><Button type="button" size="sm" disabled={saving || !apiKey.trim()} onClick={() => void saveKey()}>{saving ? 'Saving…' : connection ? 'Save key' : 'Connect'}</Button></div>
                </DetailBlock>
                {connection && <DesktopOpencodePlanLimits windows={usage.windows} capturedAt={usage.capturedAt} fresh={usage.fresh} refreshing={refreshingUsage} onRefresh={() => void refreshUsage()} />}
                {loading ? <SkeletonList rows={3} /> : (
                    <DesktopOpencodeModels
                        catalog={catalog}
                        enabledModelIds={connection?.enabledModelIds ?? []}
                        defaultModelId={connection?.defaultModelId ?? DESKTOP_OPENCODE_DEFAULT_MODEL}
                        consoleEnabled={connection?.consoleEnabled ?? false}
                        disabled={!connection || saving}
                        refreshing={refreshingModels}
                        onRefresh={connection ? () => void refreshModels() : undefined}
                        onModelsChange={change => void saveModels(change)}
                    />
                )}
            </PanelScroller>
            {connection && <div className="border-t p-3"><Button type="button" size="sm" variant="destructive" disabled={saving} onClick={() => { cancelling.current = true; setDisconnectOpen(true) }}>Remove OpenCode</Button></div>}
            <ConfirmDialog
                open={discardOpen}
                onOpenChange={next => { cancelling.current = false; setDiscardOpen(next) }}
                title="Discard changes?"
                description="Your unsaved key and connection-name changes are discarded. Saved models and credentials are not changed."
                confirmLabel="Discard"
                onConfirm={() => { setDiscardOpen(false); onBack() }}
            />
            <ConfirmDialog
                open={disconnectOpen}
                onOpenChange={next => { cancelling.current = false; setDisconnectOpen(next) }}
                title="Remove OpenCode?"
                description="The saved key is removed from this Mac. Models and defaults that used it fall back to the workspace default model."
                confirmLabel="Remove"
                pending={saving}
                onConfirm={() => void remove()}
            />
        </div>
    )
}
