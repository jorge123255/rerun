'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { PanelEditorShell, PanelEditorHeader, PanelEditorBody, PanelEditorFooter } from '@/components/ui/panel-editor'
import { desktopMcpSecretReferenceReview, type DesktopMcpSecretReferenceConfig } from '@rerun/contracts'
import {
    sameSecretReferenceAttempt,
    sameSecretReferenceOwner,
    secretReferenceAttemptId,
    secretReferenceEditorSave,
    secretReferenceEditorSlot,
    type SecretReferenceEditorAttempt,
    type SecretReferenceEditorDriver,
} from './editor-state'

export type DesktopMcpSecretReferenceEditorProps = {
    agentId: string
    origin: string
    config: DesktopMcpSecretReferenceConfig
    expectedConfigRevision: string
    expectedBindingRevision: number
    presence: { name: string; configured: boolean }[]
    readOnly?: boolean
    driver: SecretReferenceEditorDriver
    onBack(): void
    onDone(): void
    onRequestSecret?(name: string, signal: AbortSignal): Promise<void>
}

export function DesktopMcpSecretReferenceEditor(props: DesktopMcpSecretReferenceEditorProps) {
    const key = JSON.stringify([props.agentId, props.config.name, props.expectedConfigRevision, props.expectedBindingRevision, props.origin])
    return <Editor key={key} {...props} />
}

function Editor({ agentId, origin, config, expectedConfigRevision, expectedBindingRevision, presence, readOnly, driver, onBack, onDone, onRequestSecret }: DesktopMcpSecretReferenceEditorProps) {
    const review = desktopMcpSecretReferenceReview(config)
    const [replaceBearer, setReplaceBearer] = useState(false)
    const [headersText, setHeadersText] = useState(review?.headerText ?? '')
    const [envText, setEnvText] = useState(review?.envText ?? '')
    const [argsText, setArgsText] = useState(review?.argText ?? '')
    const [attempt, setAttempt] = useState<SecretReferenceEditorAttempt | null>(null)
    const [busy, setBusy] = useState(false)
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState('')
    const owner = useRef<AbortController | null>(null)
    const serial = useRef(0)
    const pending = useRef(false)
    const slot = secretReferenceEditorSlot(agentId, config.name)
    useEffect(() => {
        const controller = new AbortController()
        owner.current = controller
        const epoch = ++serial.current
        driver.journal.read(slot, controller.signal).then(saved => {
            if (controller.signal.aborted || epoch !== serial.current) return
            if (saved && !sameSecretReferenceOwner(saved, agentId, config.name)) {
                setError('Settings recovery belongs to a different coworker or server. Reopen the original request.')
                return
            }
            setAttempt(saved)
            if (saved && sameSecretReferenceAttempt(saved, agentId, config.name, expectedConfigRevision, expectedBindingRevision, origin)) {
                const restored = desktopMcpSecretReferenceReview(saved.change.config)
                if (restored) {
                    setHeadersText(restored.headerText)
                    setEnvText(restored.envText)
                    setArgsText(restored.argText)
                }
            }
            setLoaded(true)
        }).catch(() => { if (!controller.signal.aborted && epoch === serial.current) setError('Could not read settings recovery. Reopen this editor to retry.') })
        return () => { serial.current += 1; controller.abort(); owner.current = null }
    }, [driver, slot, agentId, config.name, expectedConfigRevision, expectedBindingRevision, origin])

    async function perform(next?: SecretReferenceEditorAttempt, reconcile = false) {
        if (pending.current || readOnly || !loaded || !owner.current) return
        const controller = owner.current
        const epoch = serial.current
        const current = () => !controller.signal.aborted && epoch === serial.current
        pending.current = true
        setBusy(true)
        setError('')
        try {
            const selected = attempt ?? next
            if (!selected || !(reconcile ? sameSecretReferenceOwner(selected, agentId, config.name) : sameSecretReferenceAttempt(selected, agentId, config.name, expectedConfigRevision, expectedBindingRevision, origin))) throw new Error()
            if (!attempt) {
                setAttempt(selected)
                await driver.journal.put(slot, selected, controller.signal)
                if (!current()) return
            }
            if (!current()) return
            const saveId = secretReferenceAttemptId(selected)
            const result = reconcile ? await driver.reconcile(agentId, saveId, controller.signal) : await driver.save(selected.change, controller.signal)
            if (!current()) return
            if (result.saveId !== saveId || result.agentId !== agentId || result.serverName !== config.name) throw new Error()
            if (result.status === 'not-saved') {
                await driver.journal.clear(slot, saveId, controller.signal)
                if (current()) {
                    setAttempt(null)
                    setError('Nothing was saved. Refresh the current configuration or correct the fields before another attempt.')
                }
                return
            }
            if (result.status === 'conflict') {
                await driver.journal.clear(slot, saveId, controller.signal)
                if (!current()) return
                setAttempt(null)
                setError('The credential binding changed. Refresh before saving again.')
                return
            }
            if (result.status !== 'saved' && result.status !== 'pending' && result.status !== 'replayed') {
                setError('Save acknowledgement unknown. Reconcile this exact attempt before making another change.')
                return
            }
            await driver.journal.clear(slot, saveId, controller.signal)
            if (current()) { setAttempt(null); onDone() }
        } catch {
            if (current()) setError('Settings acknowledgement unavailable. Reconcile the same attempt; no new request was created.')
        } finally {
            pending.current = false
            if (current()) setBusy(false)
        }
    }

    async function save() {
        if (!owner.current) return
        try {
            const change = await secretReferenceEditorSave({
                agentId,
                origin,
                saveId: crypto.randomUUID(),
                expectedConfigRevision,
                expectedBindingRevision,
                base: config,
                headersText,
                envText,
                argsText,
                replaceBearer,
            })
            void perform({ kind: 'save', change })
        } catch (caught) {
            const message = caught instanceof Error ? caught.message : ''
            const leaked = [headersText, envText, argsText].some(text => text.length >= 8 && message.includes(text))
            setError(!message || leaked ? 'Use header, environment, and argument references in the ${NAME} form.' : message)
        }
    }

    const requirements = review?.requirements ?? []
    const configured = (name: string) => presence.some(item => item.name === name && item.configured)
    return <div className="h-full min-h-0 min-w-0"><PanelEditorShell>
        <PanelEditorHeader title={readOnly ? 'MCP server' : 'Edit MCP server'} onBack={busy ? undefined : onBack} />
        <PanelEditorBody>
            {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
            {review?.notes.map(note => <p key={note} className="break-words text-xs text-muted-foreground">{note}</p>)}
            {review?.notes.includes('Bearer credential configured.') && <label className="flex min-h-9 items-center gap-2 text-xs"><input type="checkbox" checked={replaceBearer} disabled={readOnly || busy || !!attempt || !loaded} onChange={event => setReplaceBearer(event.target.checked)} /> Replace bearer (empty means anonymous)</label>}
            <Field label="Name" helperText={`Tools are merged as "${config.name}_<tool>".`}><p className="break-words text-sm">{config.name}</p></Field>
            <Field label="Transport"><p className="text-sm">{config.transport}</p></Field>
            {config.transport === 'stdio' ? <Field label="Command"><p className="break-all font-mono text-sm">{config.command}</p></Field> : <Field label="URL" helperText="Variable references in the URL are not supported. Put them in headers."><p className="break-all font-mono text-sm">{config.url}</p></Field>}
            <Field label="Headers" helperText="One Header=value per line. Sent with each request (use for auth). A highlighted ${NAME} is a requirement, never the saved secret.">
                <textarea aria-label="Headers" value={headersText} onChange={event => setHeadersText(event.target.value)} disabled={readOnly || busy || !!attempt || !loaded} placeholder={'Authorization=Bearer ${LINEAR_API_KEY}\nx-auth-token=${TOKEN}'} className="min-h-20 w-full min-w-0 resize-y rounded-md border border-border bg-transparent p-2 font-mono text-sm" />
            </Field>
            <Field label="Environment" helperText="One KEY=value per line. Values are stored for this coworker; a highlighted ${NAME} is a requirement, never the saved secret.">
                <textarea aria-label="Environment" value={envText} onChange={event => setEnvText(event.target.value)} disabled={readOnly || busy || !!attempt || !loaded} placeholder={'API_KEY=${API_KEY}'} className="min-h-20 w-full min-w-0 resize-y rounded-md border border-border bg-transparent p-2 font-mono text-sm" />
            </Field>
            <Field label="Arguments" helperText="One argument per line. A highlighted ${NAME} is a requirement, never the saved secret.">
                <textarea aria-label="Arguments" value={argsText} onChange={event => setArgsText(event.target.value)} disabled={readOnly || busy || !!attempt || !loaded} placeholder={'--token\n${TOKEN}'} className="min-h-20 w-full min-w-0 resize-y rounded-md border border-border bg-transparent p-2 font-mono text-sm" />
            </Field>
            <Field label="Credentials" helperText="Pending credentials stay pending until the canonical secret request stores them. This screen does not show or accept an existing secret.">
                {requirements.length === 0 ? <p className="text-xs text-muted-foreground">No credential references.</p> : <ul className="flex flex-col gap-2">{requirements.map(requirement => {
                    const ready = configured(requirement.name)
                    return <li key={`${requirement.field}:${requirement.key}:${requirement.name}`} className="flex flex-wrap items-center gap-2">
                        <span className="break-all font-mono text-xs">{requirement.name}</span>
                        <span className="text-xs text-muted-foreground">{ready ? 'Configured' : 'Pending'}</span>
                        {!readOnly && !ready && onRequestSecret && <Button size="sm" variant="outline" className="min-h-9" disabled={busy || !!attempt || !loaded} onClick={() => {
                            const controller = owner.current
                            if (!controller) return
                            void onRequestSecret(requirement.name, controller.signal).catch(() => { if (!controller.signal.aborted) setError('Credential request did not complete. Retry from the existing secret request.') })
                        }}>Request credential</Button>}
                    </li>
                })}</ul>}
            </Field>
        </PanelEditorBody>
        {!readOnly && <PanelEditorFooter><div className="flex w-full flex-wrap items-center gap-2">
            {attempt ? <Button size="sm" className="min-h-9 flex-1" disabled={busy} onClick={() => void perform(undefined, true)}>Reconcile settings</Button>
                : <Button size="sm" className="min-h-9 flex-1" disabled={busy || !loaded || !review} onClick={() => void save()}>Save changes</Button>}
        </div></PanelEditorFooter>}
    </PanelEditorShell></div>
}
