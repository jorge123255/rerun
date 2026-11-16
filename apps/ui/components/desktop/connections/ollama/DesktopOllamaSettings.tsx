'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { DESKTOP_OLLAMA, DESKTOP_OLLAMA_DOWNLOAD_URL, DESKTOP_OLLAMA_KEYS_URL, desktopOllamaKind, type ConnectionSummary, type DesktopOllamaKind } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createDesktopCustomProviderClient, uniqueName } from '@/lib/desktop/custom-providers'
import { connectLocalOllama, ollamaMessage, refreshOllama, removeOllama, saveOllamaCloudKey, type OllamaActionResult, type OllamaAdapter, type OllamaView } from '@/lib/desktop/ollama'

type Connection = Pick<ConnectionSummary, 'id' | 'name' | 'provider' | 'baseUrl' | 'customRevision'>
type Slice = { view: OllamaView | null; checking: boolean; busy: boolean; notice: string; error: string }
const idle: Slice = { view: null, checking: false, busy: false, notice: '', error: '' }

export function desktopOllamaConnection<C extends Connection>(connections: readonly C[], kind: DesktopOllamaKind): C | undefined {
    return connections.find(connection => desktopOllamaKind(connection) === kind && !!connection.customRevision)
}

/**
 * Ollama (this Mac) and Ollama Cloud for Settings. The local list is asked for when Settings
 * opens, connected or not, so "not running" is visible before anyone picks a model.
 */
export function useDesktopOllama(input: {
    workspaceId: number | null
    connections: readonly Connection[]
    defaultModel: { connectionId: string; model: string } | null
    onConnectionsChanged?: () => void
    adapter?: OllamaAdapter
}) {
    const adapter = useMemo(() => input.adapter ?? createDesktopCustomProviderClient(), [input.adapter])
    const latest = useRef(input)
    latest.current = input
    const [slices, setSlices] = useState<Record<DesktopOllamaKind, Slice>>({ ollama: idle, 'ollama-cloud': idle })
    const generation = useRef<Record<DesktopOllamaKind, number>>({ ollama: 0, 'ollama-cloud': 0 })
    const stop = useRef(new AbortController())
    const patch = useCallback((kind: DesktopOllamaKind, next: Partial<Slice>) => setSlices(current => ({ ...current, [kind]: { ...current[kind], ...next } })), [])

    const target = useCallback((kind: DesktopOllamaKind) => {
        const { workspaceId, connections, defaultModel } = latest.current
        const connection = desktopOllamaConnection(connections, kind)
        return {
            workspaceId, name: connection?.name ?? uniqueName(DESKTOP_OLLAMA[kind].name, connections.map(item => item.name)),
            connection: connection ? { id: connection.id, revision: connection.customRevision! } : null,
            defaultModelId: connection && defaultModel?.connectionId === connection.id ? defaultModel.model : null,
        }
    }, [])

    const refresh = useCallback(async (kind: DesktopOllamaKind) => {
        const { workspaceId, connection, defaultModelId } = target(kind)
        if (!workspaceId) return
        const ticket = ++generation.current[kind]
        patch(kind, { checking: true, error: '' })
        const view = await refreshOllama({ adapter, kind, workspaceId, connection, defaultModelId, signal: stop.current.signal })
        if (ticket !== generation.current[kind] || stop.current.signal.aborted) return
        patch(kind, { checking: false, view })
        if (view.changed) latest.current.onConnectionsChanged?.()
    }, [adapter, patch, target])

    const run = useCallback(async (kind: DesktopOllamaKind, done: string, work: (at: ReturnType<typeof target> & { workspaceId: number }) => Promise<OllamaActionResult>, then?: 'refresh' | 'clear') => {
        const at = target(kind)
        if (!at.workspaceId) return false
        patch(kind, { busy: true, notice: '', error: '' })
        const result = await work({ ...at, workspaceId: at.workspaceId }).catch((): OllamaActionResult => ({ ok: false, message: 'Something went wrong. Please try again.' }))
        if (stop.current.signal.aborted) return false
        if (!result.ok) { patch(kind, { busy: false, error: result.message }); return false }
        generation.current[kind] += 1
        patch(kind, { busy: false, checking: false, notice: result.warning ?? done, ...(then === 'clear' && { view: null }) })
        latest.current.onConnectionsChanged?.()
        return true
    }, [patch, target])

    const workspaceId = input.workspaceId
    const cloud = desktopOllamaConnection(input.connections, 'ollama-cloud')
    const cloudId = cloud?.id, cloudRevision = cloud?.customRevision
    useEffect(() => {
        stop.current = new AbortController()
        const controller = stop.current
        return () => controller.abort()
    }, [workspaceId])
    useEffect(() => { if (workspaceId) void refresh('ollama') }, [workspaceId, refresh])
    // A saved or replaced key is followed by the cloud's current list, read at the new revision.
    useEffect(() => { if (workspaceId && cloudId && cloudRevision) void refresh('ollama-cloud') }, [workspaceId, cloudId, cloudRevision, refresh])

    return {
        slices, refresh,
        connect: () => run('ollama', 'Ollama connected.', at => connectLocalOllama({ adapter, workspaceId: at.workspaceId, name: at.name, models: slices.ollama.view?.models ?? [], signal: stop.current.signal })),
        saveKey: (apiKey: string) => run('ollama-cloud', 'Ollama key saved.', at => saveOllamaCloudKey({ adapter, workspaceId: at.workspaceId, connection: at.connection, apiKey, defaultModelId: at.defaultModelId, name: at.name, signal: stop.current.signal })),
        remove: (kind: DesktopOllamaKind) => run(kind, kind === 'ollama' ? 'Ollama removed.' : 'Ollama Cloud and its key removed.', async at => at.connection
            ? removeOllama({ adapter, workspaceId: at.workspaceId, connection: at.connection, isDefault: latest.current.defaultModel?.connectionId === at.connection.id, signal: stop.current.signal })
            : { ok: false, message: 'Nothing to remove.' }, kind === 'ollama-cloud' ? 'clear' : undefined),
    }
}

export type DesktopOllama = ReturnType<typeof useDesktopOllama>

const link = 'text-sm font-medium underline'

export function DesktopOllamaSettings({ kind, connected, ollama }: { kind: DesktopOllamaKind; connected: boolean; ollama: DesktopOllama }) {
    const { view, checking, busy, notice, error } = ollama.slices[kind]
    const [key, setKey] = useState('')
    const local = kind === 'ollama'
    const problem = view ? ollamaMessage(kind, view.state) : null
    const models = view?.models ?? []
    const save = (event: FormEvent) => {
        event.preventDefault()
        if (key.trim()) void ollama.saveKey(key).then(saved => { if (saved) setKey('') })
    }
    return (
        <div className="space-y-3" data-ollama={kind} data-ollama-state={checking ? 'checking' : view?.state ?? 'idle'}>
            <p className="text-sm text-muted-foreground">{local
                ? 'Models served by the Ollama app on this Mac. No key, and nothing leaves this Mac. The address is fixed to http://127.0.0.1:11434.'
                : 'Models hosted by Ollama, used with your Ollama API key. Messages are sent to ollama.com.'}</p>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
            {checking && <p role="status" className="text-sm text-muted-foreground">{local ? 'Checking Ollama on this Mac…' : 'Reading the Ollama Cloud model list…'}</p>}
            {!checking && problem && <div role="status" className="space-y-1 rounded-md border border-dashed p-3 text-sm">
                <p className="font-medium">{problem}</p>
                {view?.state === 'not-running' && <p className="text-muted-foreground">Open the Ollama app, then check again. No Ollama yet? <a className={link} href={DESKTOP_OLLAMA_DOWNLOAD_URL} target="_blank" rel="noreferrer">Download Ollama</a></p>}
                {connected && models.length > 0 && view?.state !== 'ready' && <p className="text-muted-foreground">The models saved earlier stay selectable and will work again once this is fixed.</p>}
            </div>}
            {!checking && view?.state === 'ready' && <p role="status" className="text-sm">{local ? 'Ollama is running' : 'Ollama Cloud is connected'} · {models.length} {models.length === 1 ? 'model' : 'models'}{connected ? ' offered to coworkers and chats' : ' found'}</p>}
            {!local && <form onSubmit={save} className="space-y-2">
                <label htmlFor="desktop-ollama-key" className="text-sm font-medium">{connected ? 'Replacement Ollama API key' : 'Ollama API key'}</label>
                <div className="flex gap-2">
                    <Input id="desktop-ollama-key" type="password" autoComplete="off" placeholder="OLLAMA_API_KEY" value={key} onChange={event => setKey(event.target.value)} />
                    <Button type="submit" disabled={busy || !key.trim()}>{connected ? 'Save key' : 'Connect'}</Button>
                </div>
                <p className="text-xs text-muted-foreground">{connected ? 'A key is saved. It is stored encrypted on this Mac and never shown again. ' : ''}<a className="underline" href={DESKTOP_OLLAMA_KEYS_URL} target="_blank" rel="noreferrer">Create a key at ollama.com</a></p>
            </form>}
            {models.length > 0 && (connected || local) && <ul aria-label={`${DESKTOP_OLLAMA[kind].label} models`} className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2 text-sm">
                {models.map(model => <li key={model.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 break-words">{model.id}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{[model.tools === true ? 'Tools' : model.tools === false ? 'No tools' : null, model.vision ? 'Images' : null].filter(Boolean).join(' · ')}</span>
                </li>)}
            </ul>}
            {view && view.withoutTools.length > 0 && <p className="text-xs text-muted-foreground">Not offered because Ollama says they cannot call tools, which every coworker needs: {view.withoutTools.join(', ')}</p>}
            {view && !view.toolsKnown && <p className="text-xs text-muted-foreground">This Ollama does not report which models can call tools. A model without tool support will fail when a coworker uses one.</p>}
            <div className="flex flex-wrap gap-2">
                {local && !connected && <Button type="button" disabled={busy || checking || view?.state !== 'ready'} onClick={() => void ollama.connect()}>Use Ollama</Button>}
                <Button type="button" variant="outline" disabled={busy || checking || (!local && !connected)} onClick={() => void ollama.refresh(kind)}>{local ? 'Check again' : 'Refresh models'}</Button>
                {connected && <Button type="button" variant="ghost" disabled={busy} onClick={() => void ollama.remove(kind)}>{local ? 'Remove Ollama' : 'Remove key'}</Button>}
            </div>
        </div>
    )
}
