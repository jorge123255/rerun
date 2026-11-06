'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelEditorShell, PanelEditorHeader, PanelEditorBody, PanelEditorFooter, PanelDeleteButton } from '@/components/ui/panel-editor'
import type { DesktopMcpSseConfiguration, DesktopMcpSseRef } from '../../../../../packages/contracts/src/desktop-mcp-sse'
import { desktopMcpSseRefSchema } from '../../../../../packages/contracts/src/desktop-mcp-sse'
import { sameSseEditorAttempt, sameSseEditorOwner, sseAttemptId, sseEditorConfiguration, sseEditorSlot, type SseEditorAttempt, type SseEditorDriver } from './editor-state'

export function DesktopMcpTransportButtons({ value, disabled, onChange }: { value: 'stdio' | 'sse' | 'http'; disabled?: boolean; onChange?: (value: 'stdio' | 'sse' | 'http') => void }) {
    return <Field label="Transport"><div className="flex flex-wrap gap-1 rounded-md border border-border p-0.5">
        {(['stdio', 'sse', 'http'] as const).map(transport => <button key={transport} type="button" aria-pressed={value === transport}
            disabled={disabled || (!onChange && value !== transport)} onClick={() => onChange?.(transport)}
            className={`min-h-9 min-w-16 flex-1 rounded px-2 py-1 text-xs transition-colors ${value === transport ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}>{transport}</button>)}
    </div></Field>
}
export type DesktopMcpSseEditorProps = {
    agentId: string; reference?: DesktopMcpSseRef; configuration?: DesktopMcpSseConfiguration; readOnly?: boolean
    authentication: 'anonymous' | 'configured'; driver: SseEditorDriver
    onBack(): void; onDone(): void
    onChooseTransport?(transport: 'stdio' | 'sse' | 'http'): void
    onOpenAuthentication?(reference: DesktopMcpSseRef, signal: AbortSignal): Promise<void>
}
export function DesktopMcpSseEditor(props: DesktopMcpSseEditorProps) {
    const key = JSON.stringify([props.agentId, props.reference?.serverId, props.reference?.expectedRevision, props.reference?.name])
    return <Editor key={key} {...props}/>
}
function Editor({ agentId, reference, configuration, readOnly, authentication, driver, onBack, onDone, onChooseTransport, onOpenAuthentication }: DesktopMcpSseEditorProps) {
    const [name, setName] = useState(configuration?.name ?? reference?.name ?? ''), [url, setUrl] = useState(configuration?.url ?? '')
    const [attempt, setAttempt] = useState<SseEditorAttempt | null>(null), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState('')
    const owner = useRef<AbortController | null>(null), serial = useRef(0), pending = useRef(false)
    const slot = sseEditorSlot(agentId, reference?.serverId)
    const initialReference = useRef(reference).current
    useEffect(() => {
        const controller = new AbortController(); owner.current = controller; const epoch = ++serial.current
        driver.journal.read(slot, controller.signal).then(saved => {
            if (controller.signal.aborted || epoch !== serial.current) return
            if (saved && !sameSseEditorOwner(saved, agentId, initialReference)) { setError('Settings recovery belongs to a different immutable server. Reopen the original request.'); return }
            setAttempt(saved)
            if (saved?.kind === 'save' && sameSseEditorAttempt(saved, agentId, initialReference)) { setName(saved.change.configuration.name); setUrl(saved.change.configuration.url) }
            setLoaded(true)
        }).catch(() => { if (!controller.signal.aborted && epoch === serial.current) setError('Could not read settings recovery. Reopen this editor to retry.') })
        return () => { serial.current++; controller.abort(); owner.current = null }
    }, [driver, slot, agentId, initialReference])
    async function perform(next?: SseEditorAttempt, reconcile = false) {
        if (pending.current || readOnly || !loaded || !owner.current) return
        const controller = owner.current, epoch = serial.current, current = () => !controller.signal.aborted && epoch === serial.current
        pending.current = true; setBusy(true); setError('')
        try {
            const selected = attempt ?? next
            if (!selected || !(reconcile ? sameSseEditorOwner(selected, agentId, reference) : sameSseEditorAttempt(selected, agentId, reference))) throw new Error()
            if (!attempt) { setAttempt(selected); await driver.journal.put(slot, selected, controller.signal); if (!current()) return }
            if (!current()) return
            const requestId = sseAttemptId(selected)
            const result = reconcile ? await driver.reconcile(agentId, requestId, controller.signal)
                : selected.kind === 'save' ? await driver.save(selected.change, controller.signal) : await driver.remove(selected.reference, requestId, controller.signal)
            if (!current()) return
            if (result.requestId !== requestId) throw new Error()
            if (result.status === 'not-saved') {
                await driver.journal.clear(slot, requestId, controller.signal)
                if (current()) { setAttempt(null); setError('Nothing was saved. Refresh the current configuration or correct the fields before another attempt.') }
                return
            }
            if (result.status !== 'saved') { setError(result.status === 'unknown' ? 'Save acknowledgement unknown. Reconcile this exact attempt before making another change.' : 'Settings were refused. Reconcile this attempt or reopen the current configuration.'); return }
            if (result.reference) desktopMcpSseRefSchema.parse(result.reference)
            if (selected.kind === 'save' && (!result.reference || result.reference.agentId !== agentId || result.reference.name !== selected.change.configuration.name
                || reference && result.reference.serverId !== reference.serverId)) throw new Error()
            await driver.journal.clear(slot, requestId, controller.signal)
            if (current()) { setAttempt(null); onDone() }
        } catch { if (current()) setError('Settings acknowledgement unavailable. Reconcile the same attempt; no new request was created.') }
        finally { pending.current = false; if (current()) setBusy(false) }
    }
    function save() {
        try {
            const config = sseEditorConfiguration(name, url)
            void perform({ kind: 'save', change: { agentId, requestId: crypto.randomUUID(), serverId: reference?.serverId ?? null, expectedRevision: reference?.expectedRevision ?? null, configuration: config } })
        } catch { setError('Use a valid name and an HTTPS URL without credentials, query or fragment.') }
    }
    async function authenticationFlow() {
        if (!reference || !onOpenAuthentication || !owner.current || pending.current) return
        const controller = owner.current, epoch = serial.current
        pending.current = true; setBusy(true)
        try { await onOpenAuthentication(reference, controller.signal) }
        catch { if (!controller.signal.aborted && epoch === serial.current) setError('Authentication setup did not complete. Retry in the existing MCP settings.') }
        finally { pending.current = false; if (!controller.signal.aborted && epoch === serial.current) setBusy(false) }
    }
    return <div className="h-full min-h-0 min-w-0"><PanelEditorShell>
        <PanelEditorHeader title={readOnly ? 'MCP server' : reference ? 'Edit MCP server' : 'New MCP server'} onBack={busy ? undefined : onBack}/>
        <PanelEditorBody>
            {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
            {readOnly && <p className="text-xs text-muted-foreground">This MCP server is provided by an app and is managed automatically.</p>}
            <Field label="Name" helperText={`Tools are merged as "${name.trim() || 'name'}_<tool>".`}><Input value={name} onChange={event => setName(event.target.value)} disabled={!!reference || readOnly || busy || !!attempt || !loaded} className="h-8 text-sm" placeholder="filesystem"/></Field>
            <DesktopMcpTransportButtons value="sse" disabled={readOnly || busy || !!attempt || !loaded} onChange={onChooseTransport}/>
            <Field label="URL"><Input value={url} onChange={event => setUrl(event.target.value)} disabled={readOnly || busy || !!attempt || !loaded} className="h-8 text-sm" placeholder="https://example.com/sse"/></Field>
            <Field label="Headers" helperText="Authentication is managed by the existing per-server MCP settings. Header values are never returned here.">
                <p className="break-words text-xs text-muted-foreground">{authentication === 'configured' ? 'Authentication configured.' : 'Anonymous connection.'}</p>
                {!readOnly && reference && onOpenAuthentication && <Button size="sm" variant="outline" disabled={busy || !!attempt || !loaded} onClick={() => void authenticationFlow()}>Configure authentication</Button>}
            </Field>
        </PanelEditorBody>
        {!readOnly && <PanelEditorFooter><div className="flex w-full flex-wrap items-center gap-2">
            {attempt ? <Button size="sm" className="min-h-9 flex-1" disabled={busy} onClick={() => void perform(undefined, true)}>Reconcile settings</Button> : <>
                {reference && <PanelDeleteButton label="Delete server" disabled={busy || !loaded} busy={busy} onClick={() => void perform({ kind: 'delete', requestId: crypto.randomUUID(), reference })}
                    confirmTitle={`Delete ${name || 'this server'}?`} confirmDescription="The coworker loses every tool this server exposes. Existing credentials are handled by the current MCP settings policy."/>}
                <Button size="sm" className="min-h-9 flex-1" disabled={busy || !loaded || !name.trim() || !url.trim()} onClick={save}>{reference ? 'Save changes' : 'Create server'}</Button>
            </>}
        </div></PanelEditorFooter>}
    </PanelEditorShell></div>
}
