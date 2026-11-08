'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelScroller } from '@/components/ui/panel-list'
import { applyProbe, buildCustomProviderConfig, connectReady, createDesktopCustomProviderClient, endpointReady, keyRequiredFor, normalizeBase, parseWindow, policyFor, presetForUrl, probeProblemMessage, selectionFromDraftProbe, uniqueName, CONNECT_FAILED, CUSTOM_PROVIDER_HEADER, CUSTOM_PROVIDER_HINT, LAST_MODEL_LOCK, OTHER_WORKSPACE, UNAVAILABLE_MESSAGE, desktopPresets, type DesktopCustomPreset, type DesktopCustomProviderClient, type ProbeTicket } from '@/lib/desktop/custom-providers'
import { ChevronLeftIcon } from '@/lib/icons'
import type { CustomProviderChange, CustomProviderIdentity, CustomProviderModel, CustomProviderReceipt, CustomProviderSnapshot } from '@rerun/contracts'
import { useEffect, useId, useRef, useState } from 'react'
import { DesktopCustomEndpointSettings } from './DesktopCustomEndpointSettings'
import { DesktopCustomModelList } from './DesktopCustomModelList'
import { DesktopCustomPresetPicker } from './DesktopCustomPresetPicker'

type Adapter = Pick<DesktopCustomProviderClient, 'read' | 'probe' | 'probeDraft' | 'change'>

export type DesktopCustomProviderPageProps = {
    workspaceId: number
    identity?: CustomProviderIdentity | null
    takenNames: string[]
    defaultModel?: { connectionId: string; model: string } | null
    willBecomeBoxDefault?: boolean
    adapter?: Adapter
    onBack: () => void
    returnFocusId?: string
    onReceipt?: (receipt: CustomProviderReceipt) => void
}

type Draft = {
    name: string
    baseUrl: string
    presetId: DesktopCustomPreset['id'] | null
    apiKey: string
    clearSecret: boolean
    modelId: string
    asksModel: boolean
    selected: CustomProviderModel[]
    catalogModels: CustomProviderModel[]
    catalogStatus: CustomProviderSnapshot['catalog']['status']
    vision: boolean
    contextText: string
}

function emptyDraft(taken: string[]): Draft {
    const preset = desktopPresets()[0] ?? null
    return {
        name: preset ? uniqueName(preset.label, taken) : uniqueName('Custom', taken),
        baseUrl: preset?.baseUrl ?? '',
        presetId: preset?.id ?? null,
        apiKey: '', clearSecret: false, modelId: '', asksModel: false, selected: [], catalogModels: [], catalogStatus: 'never', vision: false, contextText: '',
    }
}

function fromSnapshot(snapshot: CustomProviderSnapshot): Draft {
    return {
        name: snapshot.config.name,
        baseUrl: snapshot.config.baseUrl,
        presetId: snapshot.config.preset,
        apiKey: '', clearSecret: false, modelId: '', asksModel: false,
        selected: snapshot.config.models,
        catalogModels: snapshot.catalog.models,
        catalogStatus: snapshot.catalog.status,
        vision: snapshot.config.vision,
        contextText: snapshot.config.contextWindow ? String(snapshot.config.contextWindow) : '',
    }
}

function isDirty(draft: Draft, saved: CustomProviderSnapshot): boolean {
    const base = fromSnapshot(saved)
    return draft.name !== base.name || normalizeBase(draft.baseUrl) !== normalizeBase(base.baseUrl) || draft.vision !== base.vision || draft.contextText !== base.contextText || draft.clearSecret || draft.apiKey.trim() !== '' || JSON.stringify(draft.selected) !== JSON.stringify(base.selected)
}

function identityOf(snapshot: CustomProviderSnapshot): CustomProviderIdentity {
    return { workspaceId: snapshot.workspaceId, connectionId: snapshot.connectionId, revision: snapshot.revision }
}

function newId(): string | null {
    try {
        const id = crypto.randomUUID()
        return id ? id : null
    } catch {
        return null
    }
}

function ensure(slot: { current: string }): string | null {
    if (!slot.current) slot.current = newId() ?? ''
    return slot.current || null
}

function bodyOf(change: CustomProviderChange): string {
    if (change.action === 'disconnect') return 'disconnect'
    return JSON.stringify({
        name: change.config.name,
        baseUrl: change.config.baseUrl,
        preset: change.config.preset,
        models: change.config.models,
        contextWindow: change.config.contextWindow,
        vision: change.config.vision,
        policy: change.config.policy,
        clearSecret: change.action === 'update' ? Boolean(change.clearSecret) : false,
    })
}

function acceptsReplay(current: CustomProviderChange, heldChange: CustomProviderChange): boolean {
    if (current.action !== heldChange.action || bodyOf(current) !== bodyOf(heldChange)) return false
    if (current.action === 'disconnect' || heldChange.action === 'disconnect') return true
    const typed = current.apiKey ?? ''
    const sent = heldChange.apiKey ?? ''
    return typed === '' || typed === sent
}

function scrub(message: string, secret: string): string {
    return secret.length > 0 && message.includes(secret) ? UNAVAILABLE_MESSAGE : message
}

export function DesktopCustomProviderPage({ workspaceId, identity = null, takenNames, defaultModel = null, willBecomeBoxDefault = false, adapter, onBack, returnFocusId, onReceipt }: DesktopCustomProviderPageProps) {
    const formId = useId()
    const fallback = useRef<Adapter | null>(null)
    if (!fallback.current) fallback.current = createDesktopCustomProviderClient()
    const clientRef = useRef<Adapter>(adapter ?? fallback.current)
    clientRef.current = adapter ?? fallback.current
    const [saved, setSaved] = useState<CustomProviderSnapshot | null>(null)
    const [draft, setDraft] = useState<Draft>(() => emptyDraft(takenNames))
    const [busy, setBusy] = useState(false)
    const [loaded, setLoaded] = useState(!identity)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [epoch, setEpoch] = useState(0)
    const [reload, setReload] = useState(0)
    const [confirmDisconnect, setConfirmDisconnect] = useState(false)
    const draftRef = useRef(draft)
    const savedRef = useRef(saved)
    const dirtyRef = useRef(false)
    const workspaceRef = useRef(workspaceId)
    const seenWorkspace = useRef(workspaceId)
    const identityRef = useRef(identity)
    const takenRef = useRef(takenNames)
    const onReceiptRef = useRef(onReceipt)
    const defaultRef = useRef<string | null>(null)
    const probeGen = useRef(0)
    const probeAbort = useRef<AbortController | null>(null)
    const saveRequest = useRef('')
    const connectionDraftId = useRef('')
    const disconnectRequest = useRef('')
    const seedRef = useRef<string | null>(null)
    const held = useRef<CustomProviderChange | null>(null)
    const opened = useRef<CustomProviderIdentity | null>(null)
    draftRef.current = draft
    savedRef.current = saved
    takenRef.current = takenNames
    identityRef.current = identity
    onReceiptRef.current = onReceipt
    workspaceRef.current = workspaceId
    dirtyRef.current = saved ? isDirty(draft, saved) : false
    defaultRef.current = saved && defaultModel?.connectionId === saved.connectionId ? defaultModel.model : null
    const propKey = `${workspaceId}\0${identity?.workspaceId ?? ''}\0${identity?.connectionId ?? ''}\0${identity?.revision ?? ''}\0${reload}`

    useEffect(() => {
        const controller = new AbortController()
        let alive = true
        const currentWorkspace = workspaceRef.current
        const currentIdentity = identityRef.current
        if (seenWorkspace.current !== currentWorkspace) {
            seenWorkspace.current = currentWorkspace
            probeGen.current += 1
            probeAbort.current?.abort()
            saveRequest.current = ''
            connectionDraftId.current = ''
            disconnectRequest.current = ''
            seedRef.current = null
            held.current = null
            opened.current = null
        }
        if (!currentIdentity || currentIdentity.workspaceId !== currentWorkspace) {
            setSaved(null)
            setDraft(emptyDraft(takenRef.current))
            setError(currentIdentity ? OTHER_WORKSPACE : null)
            setStatus(null)
            setLoaded(true)
            setEpoch(value => value + 1)
            return () => { alive = false; controller.abort() }
        }
        setLoaded(false)
        void clientRef.current.read(currentIdentity, controller.signal).then(result => {
            if (!alive) return
            if (!result.ok) {
                if (result.reason !== 'cancelled' && !savedRef.current) setError(result.message)
                return
            }
            if (result.value.workspaceId !== currentWorkspace || result.value.connectionId !== currentIdentity.connectionId) {
                setSaved(null)
                setError(OTHER_WORKSPACE)
                return
            }
            if (dirtyRef.current && savedRef.current) return
            if (savedRef.current?.revision === result.value.revision && savedRef.current.connectionId === result.value.connectionId) return
            setSaved(result.value)
            setDraft(fromSnapshot(result.value))
            setError(null)
            setEpoch(value => value + 1)
        }).finally(() => { if (alive) setLoaded(true) })
        return () => { alive = false; controller.abort() }
    }, [propKey])

    const preset = presetForUrl(draft.baseUrl)
    const keyRequired = keyRequiredFor(preset)
    const secretSaved = Boolean(saved?.configuredSecret) && !draft.clearSecret
    const ready = connectReady({ name: draft.name, baseUrl: draft.baseUrl, keyRequired, secretSaved, apiKey: draft.apiKey, asksModel: saved ? false : draft.asksModel, modelId: draft.modelId })
    const foreign = identity != null && identity.workspaceId !== workspaceId
    const showAdd = !saved && !identity && !foreign

    function bumpProbe() {
        probeGen.current += 1
        probeAbort.current?.abort()
    }

    function back() {
        onBack()
        if (returnFocusId) document.getElementById(returnFocusId)?.focus()
    }

    function pick(next: DesktopCustomPreset | null) {
        bumpProbe()
        setDraft(current => ({ ...current, presetId: next?.id ?? null, name: next ? uniqueName(next.label, takenRef.current) : uniqueName('Custom', takenRef.current), baseUrl: next?.baseUrl ?? '', asksModel: false }))
        setError(null)
    }

    function commitBaseUrl(value: string) {
        const next = normalizeBase(value)
        if (!endpointReady(next) || next === normalizeBase(draftRef.current.baseUrl)) return
        bumpProbe()
        const nextDraft = { ...draftRef.current, baseUrl: next, presetId: presetForUrl(next)?.id ?? null }
        draftRef.current = nextDraft
        setDraft(nextDraft)
    }

    function commitContext(text: string) {
        const parsed = parseWindow(text)
        if (parsed === undefined) return
        const nextDraft = { ...draftRef.current, contextText: parsed === null ? '' : String(parsed) }
        draftRef.current = nextDraft
        setDraft(nextDraft)
    }

    async function runProbe(snapshot: CustomProviderSnapshot, generation: number, signal: AbortSignal): Promise<boolean> {
        const workspace = workspaceRef.current
        if (normalizeBase(draftRef.current.baseUrl) !== normalizeBase(snapshot.config.baseUrl)) {
            setError('Save the endpoint before checking it again.')
            return true
        }
        const ticket: ProbeTicket = { generation, workspaceId: workspace, connectionId: snapshot.connectionId, revision: snapshot.revision, baseUrl: snapshot.config.baseUrl }
        const typed = draftRef.current.modelId.trim()
        const manualModel = typed && snapshot.config.models.some(model => model.id === typed) ? typed : undefined
        const probed = await clientRef.current.probe(identityOf(snapshot), manualModel, signal)
        const current: ProbeTicket = { generation: probeGen.current, workspaceId: workspaceRef.current, connectionId: snapshot.connectionId, revision: snapshot.revision, baseUrl: normalizeBase(draftRef.current.baseUrl) }
        if (signal.aborted || workspaceRef.current !== workspace) return true
        if (!probed.ok) {
            if (probed.reason !== 'cancelled') setError(scrub(probed.message, draftRef.current.apiKey.trim()))
            return true
        }
        const applied = applyProbe({ ticket, current, probe: probed.value, selected: draftRef.current.selected.length ? draftRef.current.selected : snapshot.config.models, manualSeedId: seedRef.current, defaultModelId: defaultRef.current })
        if (!applied.apply) return false
        seedRef.current = null
        setDraft(currentDraft => ({
            ...currentDraft,
            selected: applied.selected,
            catalogModels: applied.catalogModels ?? currentDraft.catalogModels,
            catalogStatus: applied.catalogModels ? (applied.catalogModels.length ? 'fresh' : 'empty') : currentDraft.catalogStatus,
            asksModel: applied.asksModel || currentDraft.asksModel,
        }))
        if (applied.notice) setError(applied.notice)
        return true
    }

    function release(change: CustomProviderChange) {
        held.current = null
        if (change.action === 'create') {
            saveRequest.current = ''
            connectionDraftId.current = ''
        } else if (change.action === 'update') saveRequest.current = ''
        else disconnectRequest.current = ''
    }

    function rebuild(change: CustomProviderChange): CustomProviderChange | null {
        if (change.action === 'disconnect') {
            const snapshot = savedRef.current
            if (!snapshot) return null
            return { action: 'disconnect', requestId: change.requestId, identity: identityOf(snapshot) }
        }
        const current = draftRef.current
        let config
        try {
            config = buildCustomProviderConfig({ name: current.name, baseUrl: current.baseUrl, models: change.action === 'create' ? change.config.models : current.selected, contextText: current.contextText, vision: current.vision })
        } catch {
            return null
        }
        const key = current.apiKey.trim()
        if (change.action === 'create') return { action: 'create', requestId: change.requestId, workspaceId: change.workspaceId, connectionId: change.connectionId, config, ...(key ? { apiKey: key } : {}) }
        const snapshot = savedRef.current
        if (!snapshot) return null
        return { action: 'update', requestId: change.requestId, identity: identityOf(snapshot), config, ...(key ? { apiKey: key } : {}), clearSecret: current.clearSecret && !key }
    }

    async function finishChange(change: CustomProviderChange, controller: AbortController, workspace: number): Promise<CustomProviderSnapshot | null> {
        held.current = change
        const secret = change.action === 'disconnect' ? '' : change.apiKey ?? ''
        const result = await clientRef.current.change(change, controller.signal)
        if (controller.signal.aborted || workspaceRef.current !== workspace) return null
        if (!result.ok) {
            if (result.reason === 'invalid' || result.reason === 'refused') release(change)
            else setStatus('Saved, waiting to confirm the receipt.')
            setError(scrub(result.message, secret))
            return null
        }
        const receiptId = result.value.identity
        if (receiptId.workspaceId !== workspace || (change.action === 'create' ? receiptId.connectionId !== change.connectionId : receiptId.connectionId !== change.identity.connectionId)) {
            setError(OTHER_WORKSPACE)
            return null
        }
        const recorded = result.value.status === 'recorded'
        if (recorded) {
            opened.current = receiptId
            release(change)
        } else setStatus('Saved, waiting to confirm the receipt.')
        onReceiptRef.current?.(result.value)
        const readBack = await clientRef.current.read(receiptId, controller.signal)
        if (controller.signal.aborted || workspaceRef.current !== workspace) return null
        if (!readBack.ok || readBack.value.workspaceId !== workspace || readBack.value.connectionId !== receiptId.connectionId || readBack.value.revision !== receiptId.revision) {
            setStatus('Saved, waiting to confirm the receipt.')
            setError(readBack.ok ? OTHER_WORKSPACE : scrub(readBack.message, secret))
            return null
        }
        opened.current = null
        const nextDraft = fromSnapshot(readBack.value)
        savedRef.current = readBack.value
        draftRef.current = nextDraft
        setSaved(readBack.value)
        setDraft(nextDraft)
        setEpoch(value => value + 1)
        setConfirmDisconnect(false)
        if (!recorded || result.value.recovered) setStatus('Saved, waiting to confirm the receipt.')
        else setStatus(null)
        return readBack.value
    }

    async function connect() {
        if (busy) return
        const generation = probeGen.current
        const workspace = workspaceRef.current
        const controller = new AbortController()
        probeAbort.current = controller
        setBusy(true)
        setError(null)
        setStatus('Checking this server…')
        try {
            const pending = held.current
            if (pending) {
                const snapshot = await finishChange(pending, controller, workspace)
                if (snapshot && pending.action !== 'disconnect') await runProbe(snapshot, generation, controller.signal)
                return
            }
            if (!savedRef.current && opened.current) {
                const readBack = await clientRef.current.read(opened.current, controller.signal)
                if (controller.signal.aborted || workspaceRef.current !== workspace) return
                if (!readBack.ok || readBack.value.workspaceId !== workspace || readBack.value.connectionId !== opened.current.connectionId || readBack.value.revision !== opened.current.revision) {
                    setError(readBack.ok ? OTHER_WORKSPACE : scrub(readBack.message, ''))
                    return
                }
                opened.current = null
                savedRef.current = readBack.value
                draftRef.current = fromSnapshot(readBack.value)
                setSaved(readBack.value)
                setDraft(draftRef.current)
                await runProbe(readBack.value, generation, controller.signal)
                return
            }
            const existing = savedRef.current
            if (existing) {
                await runProbe(existing, generation, controller.signal)
                return
            }
            const currentDraft = draftRef.current
            const baseUrl = normalizeBase(currentDraft.baseUrl)
            if (!endpointReady(baseUrl)) {
                setError('Check the address and try again.')
                return
            }
            const requestId = newId()
            if (!requestId) {
                setError(UNAVAILABLE_MESSAGE)
                return
            }
            const key = currentDraft.apiKey.trim()
            const manual = currentDraft.asksModel ? currentDraft.modelId.trim() : ''
            const drafted = await clientRef.current.probeDraft({
                action: 'probe_draft', requestId, workspaceId: workspace, baseUrl, policy: policyFor(baseUrl), ...(key ? { apiKey: key } : {}), ...(manual ? { manualModel: manual } : {}),
            }, controller.signal)
            if (controller.signal.aborted || workspaceRef.current !== workspace || probeGen.current !== generation) return
            if (normalizeBase(draftRef.current.baseUrl) !== baseUrl || draftRef.current.apiKey.trim() !== key || (draftRef.current.asksModel ? draftRef.current.modelId.trim() : '') !== manual) return
            if (!drafted.ok) {
                if (drafted.reason !== 'cancelled') setError(scrub(drafted.message, key))
                return
            }
            if (drafted.value.requestId !== requestId || drafted.value.workspaceId !== workspace) return
            const picked = selectionFromDraftProbe(drafted.value)
            const notice = probeProblemMessage(drafted.value.problem, baseUrl, drafted.value.manualModel)
            if (!picked.models) {
                if (picked.asksModel) {
                    const next = { ...draftRef.current, asksModel: true }
                    draftRef.current = next
                    setDraft(next)
                }
                if (notice) setError(notice)
                return
            }
            let config
            try {
                config = buildCustomProviderConfig({ name: draftRef.current.name, baseUrl: draftRef.current.baseUrl, models: picked.models, contextText: draftRef.current.contextText, vision: draftRef.current.vision })
            } catch {
                setError('Check the address and try again.')
                return
            }
            const createId = ensure(saveRequest)
            const connectionId = ensure(connectionDraftId)
            if (!createId || !connectionId) {
                setError(UNAVAILABLE_MESSAGE)
                return
            }
            const typedKey = draftRef.current.apiKey.trim()
            const created = await finishChange({ action: 'create', requestId: createId, workspaceId: workspace, connectionId, config, ...(typedKey ? { apiKey: typedKey } : {}) }, controller, workspace)
            if (!created) return
            const sawProbe = await runProbe(created, generation, controller.signal)
            if (!sawProbe && notice) setError(notice)
        } catch {
            if (!controller.signal.aborted) setError(CONNECT_FAILED)
        } finally {
            if (probeAbort.current === controller) probeAbort.current = null
            setBusy(false)
            setStatus(current => current === 'Checking this server…' ? null : current)
        }
    }

    async function save() {
        const snapshot = savedRef.current
        const currentDraft = draftRef.current
        if (!snapshot || busy) return
        if (held.current && held.current.action !== 'update') {
            setStatus('Saved, waiting to confirm the receipt.')
            return
        }
        if (currentDraft.selected.length === 0) {
            setError(LAST_MODEL_LOCK)
            return
        }
        let config
        try {
            config = buildCustomProviderConfig({ name: currentDraft.name, baseUrl: currentDraft.baseUrl, models: currentDraft.selected, contextText: currentDraft.contextText, vision: currentDraft.vision })
        } catch {
            setError('Check the address and try again.')
            return
        }
        const requestId = held.current?.action === 'update' ? held.current.requestId : ensure(saveRequest)
        if (!requestId) {
            setError(UNAVAILABLE_MESSAGE)
            return
        }
        const key = currentDraft.apiKey.trim()
        const change: CustomProviderChange = { action: 'update', requestId, identity: identityOf(snapshot), config, ...(key ? { apiKey: key } : {}), clearSecret: currentDraft.clearSecret && !key }
        if (held.current?.action === 'update') {
            const rebuilt = rebuild(held.current)
            if (!rebuilt || !acceptsReplay(rebuilt, held.current)) {
                setStatus('Saved, waiting to confirm the receipt.')
                return
            }
        }
        const workspace = workspaceRef.current
        const controller = new AbortController()
        probeAbort.current = controller
        setBusy(true)
        setError(null)
        try {
            await finishChange(held.current?.action === 'update' ? held.current : change, controller, workspace)
        } catch {
            if (!controller.signal.aborted) setError(CONNECT_FAILED)
        } finally {
            if (probeAbort.current === controller) probeAbort.current = null
            setBusy(false)
        }
    }

    async function disconnect() {
        const snapshot = savedRef.current
        if (!snapshot || busy) return
        if (held.current && held.current.action !== 'disconnect') {
            setStatus('Saved, waiting to confirm the receipt.')
            return
        }
        const requestId = held.current?.action === 'disconnect' ? held.current.requestId : ensure(disconnectRequest)
        if (!requestId) {
            setError(UNAVAILABLE_MESSAGE)
            return
        }
        const change: CustomProviderChange = held.current?.action === 'disconnect' ? held.current : { action: 'disconnect', requestId, identity: identityOf(snapshot) }
        const workspace = workspaceRef.current
        const controller = new AbortController()
        probeAbort.current = controller
        setBusy(true)
        setError(null)
        try {
            await finishChange(change, controller, workspace)
        } catch {
            if (!controller.signal.aborted) setError(CONNECT_FAILED)
        } finally {
            if (probeAbort.current === controller) probeAbort.current = null
            setBusy(false)
        }
    }

    const dirty = saved ? isDirty(draft, saved) : false
    const missingDefault = Boolean(defaultRef.current) && !draft.selected.some(model => model.id === defaultRef.current) && !draft.catalogModels.some(model => model.id === defaultRef.current)
    const holdsDefault = saved && defaultModel?.connectionId === saved.connectionId

    return (
        <div data-custom-provider-page="" data-connection-state={saved?.state ?? 'new'} aria-busy={busy} className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-3 border-b px-3 py-2.5">
                <Button type="button" aria-label="Back to AI providers" variant="ghost" size="icon-sm" className="shrink-0" onClick={back}><ChevronLeftIcon className="size-4" /></Button>
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{CUSTOM_PROVIDER_HEADER}</span>
                    <span className="truncate text-[11px] text-muted-foreground">{CUSTOM_PROVIDER_HINT}</span>
                </div>
            </div>
            <PanelScroller className="min-h-0 space-y-4 overflow-y-auto p-4">
                {saved?.state === 'disconnected' && <p className="text-[11px] text-muted-foreground">Disconnected</p>}
                {status && <p role="status" className="text-[11px] text-muted-foreground">{status}</p>}
                {error && <p role="alert" className="min-w-0 flex-1 text-[11px] break-words text-destructive">{error}</p>}
                {!loaded && identity && !saved && !foreign && <p role="status" className="text-[11px] text-muted-foreground">Checking this server…</p>}
                {identity && !saved && loaded && !foreign && <Button type="button" size="sm" variant="outline" onClick={() => setReload(value => value + 1)}>Retry</Button>}
                {showAdd && (
                    <fieldset disabled={busy} className="min-w-0 space-y-4">
                        <DesktopCustomPresetPicker id={`${formId}-server`} selected={draft.presetId} onPick={pick} />
                        <Input id={`${formId}-name`} label="Name" value={draft.name} maxLength={60} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} helperText="Shown in every coworker's model picker" className="h-8" />
                        <Input hideRequired id={`${formId}-base-url`} label="Base URL" value={draft.baseUrl} onChange={event => setDraft(current => ({ ...current, baseUrl: event.target.value }))} placeholder="https://your-server.com/v1" inputMode="url" autoComplete="off" spellCheck={false} className="h-8 font-mono text-xs" />
                        <Input hideRequired={keyRequired} optional={!keyRequired} id={`${formId}-api-key`} label="API key" type="password" value={draft.apiKey} onChange={event => setDraft(current => ({ ...current, apiKey: event.target.value }))} placeholder={keyRequired ? 'Paste your key' : 'None for a local server'} autoComplete="off" className="h-8 font-mono text-xs" />
                        {draft.asksModel && <Input id={`${formId}-model`} hideRequired autoFocus label="Model id" value={draft.modelId} maxLength={256} onChange={event => setDraft(current => ({ ...current, modelId: event.target.value }))} placeholder="llama3.3:70b" spellCheck={false} className="h-8 font-mono text-xs" />}
                        {willBecomeBoxDefault && <p className="text-[11px] text-muted-foreground">This becomes the workspace default: every coworker with no model of its own will run on it.</p>}
                    </fieldset>
                )}
                {saved && (
                    <fieldset disabled={busy} className="min-w-0 space-y-5">
                        <Input id={`${formId}-name`} label="Name" value={draft.name} maxLength={60} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} helperText="Shown in every coworker's model picker" className="h-8" />
                        <Input hideRequired={keyRequired} optional={!keyRequired} id={`${formId}-api-key`} label="API key" type="password" autoComplete="off" value={draft.apiKey} onChange={event => setDraft(current => ({ ...current, apiKey: event.target.value }))} placeholder={saved.configuredSecret ? 'Paste your key' : keyRequired ? 'Paste your key' : 'None for a local server'} helperText={saved.configuredSecret ? 'Saved keys stay hidden.' : undefined} className="h-8 font-mono text-xs" />
                        {saved.configuredSecret && !draft.clearSecret && <Button type="button" size="sm" variant="outline" onClick={() => setDraft(current => ({ ...current, clearSecret: true, apiKey: '' }))}>Remove saved key</Button>}
                        {draft.clearSecret && <p className="text-[11px] text-muted-foreground">The saved key will be removed when you save.</p>}
                        {draft.asksModel && <Input id={`${formId}-model`} hideRequired label="Model id" value={draft.modelId} maxLength={256} onChange={event => setDraft(current => ({ ...current, modelId: event.target.value }))} placeholder="llama3.3:70b" spellCheck={false} className="h-8 font-mono text-xs" />}
                        <DesktopCustomModelList selected={draft.selected} catalog={draft.catalogModels} catalogStatus={draft.catalogStatus} connectionVision={draft.vision} defaultModelId={defaultRef.current} missingDefault={missingDefault} onTurnOff={id => { if (id === defaultRef.current || draftRef.current.selected.length === 1) return; seedRef.current = null; setDraft(current => ({ ...current, selected: current.selected.filter(model => model.id !== id) })) }} onTurnOn={id => { const row = draft.catalogModels.find(model => model.id === id); if (!row || draft.selected.some(model => model.id === id)) return; seedRef.current = null; setDraft(current => ({ ...current, selected: [...current.selected, row] })) }} onAdd={id => { const value = id.trim(); if (!value || value.length > 256 || draft.selected.some(model => model.id === value) || draft.catalogModels.some(model => model.id === value)) return; seedRef.current = null; setDraft(current => ({ ...current, selected: [...current.selected, { id: value, contextWindow: null, vision: false, source: 'manual' }] })) }} onWindow={(id, value) => setDraft(current => ({ ...current, selected: current.selected.map(model => model.id === id && model.source === 'manual' ? { ...model, contextWindow: value } : model) }))} onVision={(id, value) => setDraft(current => ({ ...current, selected: current.selected.map(model => model.id === id ? { ...model, vision: value } : model) }))} />
                        <DesktopCustomEndpointSettings id={saved.connectionId} baseUrl={draft.baseUrl} contextText={draft.contextText} vision={draft.vision} epoch={epoch} onBaseUrl={commitBaseUrl} onContext={commitContext} onVision={value => setDraft(current => ({ ...current, vision: value }))} />
                    </fieldset>
                )}
                <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
                    {showAdd && <Button type="button" size="sm" disabled={busy || !ready} onClick={() => void connect()}>{busy ? 'Connecting…' : 'Connect'}</Button>}
                    {saved && dirty && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { if (savedRef.current) { setDraft(fromSnapshot(savedRef.current)); setEpoch(value => value + 1); setError(null) } }}>Discard</Button>}
                    {saved && dirty && <Button type="button" size="sm" disabled={busy || !ready || draft.selected.length === 0} onClick={() => void save()}>Save</Button>}
                    {saved && !busy && <Button type="button" size="sm" variant="outline" onClick={() => void connect()}>Retry</Button>}
                    {busy && <Button type="button" size="sm" variant="outline" onClick={() => { bumpProbe(); setBusy(false); setStatus(null) }}>Cancel</Button>}
                </div>
            </PanelScroller>
            {saved && (
                <div className="border-t p-3">
                    {confirmDisconnect ? (
                        <div className="space-y-2">
                            <p className="text-[11px] text-muted-foreground">Disconnect {saved.config.name}? The workspace default and this chat stay where they are.{holdsDefault ? ' This connection is the workspace default. Disconnecting it does not choose a replacement.' : ''}</p>
                            <div className="flex flex-wrap gap-2">
                                <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button>
                                <Button type="button" size="sm" variant="outline" onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
                            </div>
                        </div>
                    ) : <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => setConfirmDisconnect(true)}>Disconnect {saved.config.name}</Button>}
                </div>
            )}
        </div>
    )
}


