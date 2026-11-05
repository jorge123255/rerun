'use client'

import { DesktopTriggerUrlField } from '@/components/desktop/triggers/DesktopTriggerUrlField'
import { PanelDeleteButton, PanelEditorBody, PanelEditorFooter, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SkeletonRows } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { MarkdownTextarea } from '@/components/ui/markdown-textarea'
import { HistoryIcon } from '@/lib/icons'
import {
    createDesktopTrigger,
    deleteDesktopTrigger,
    getDesktopTrigger,
    rotateDesktopTrigger,
    updateDesktopTrigger,
    TriggerRequestError,
} from '@/lib/desktop/triggers'
import type { DesktopTrigger, DesktopTriggerMethod } from '@rerun/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'

const ALL_METHODS: DesktopTriggerMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const DEFAULT_METHODS: DesktopTriggerMethod[] = ['POST']

type Props = {
    agentId: string
    slug?: string
    onDone: () => void
    onBack: () => void
    onShowHistory?: () => void
    ingressAvailable?: boolean
}

export function DesktopTriggerEditor({ agentId, slug, onDone, onBack, onShowHistory, ingressAvailable = false }: Props) {
    const isEdit = !!slug
    const [loading, setLoading] = useState(isEdit)
    const [trigger, setTrigger] = useState<DesktopTrigger | null>(null)
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [methods, setMethods] = useState<DesktopTriggerMethod[]>(DEFAULT_METHODS)
    const [enabled, setEnabled] = useState(true)
    const [body, setBody] = useState('')
    const [model, setModel] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [rotating, setRotating] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [dirty, setDirty] = useState(false)
    const loadGen = useRef(0)
    const alive = useRef(true)

    useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
    }, [])

    useEffect(() => {
        if (!slug) return
        const gen = ++loadGen.current
        setLoading(true)
        setError(null)
        getDesktopTrigger(agentId, slug)
            .then(t => {
                if (!alive.current || gen !== loadGen.current) return
                setTrigger(t)
                setName(t.name)
                setDescription(t.description ?? '')
                setMethods(t.methods.length ? t.methods : DEFAULT_METHODS)
                setEnabled(t.enabled ?? true)
                setModel(t.model)
                setBody(t.body ?? '')
                setDirty(false)
            })
            .catch(err => {
                if (!alive.current || gen !== loadGen.current) return
                setError(err instanceof TriggerRequestError ? err.message : 'Could not load trigger')
            })
            .finally(() => {
                if (alive.current && gen === loadGen.current) setLoading(false)
            })
    }, [agentId, slug])

    const toggleMethod = useCallback((method: DesktopTriggerMethod, checked: boolean) => {
        setDirty(true)
        setMethods(current => {
            const next = checked ? [...current, method] : current.filter(m => m !== method)
            return next.length ? ALL_METHODS.filter(m => next.includes(m)) : current
        })
    }, [])

    const handleBack = useCallback(() => {
        if (dirty && !window.confirm('Discard unsaved trigger changes?')) return
        onBack()
    }, [dirty, onBack])

    const handleSave = useCallback(async () => {
        setSaving(true)
        setError(null)
        try {
            if (isEdit) {
                if (!trigger) throw new Error('Trigger not loaded')
                await updateDesktopTrigger(agentId, slug!, {
                    requestId: crypto.randomUUID(),
                    expectedRevision: trigger.revision,
                    description,
                    body,
                    methods,
                    enabled,
                    connectionId: null,
                    provider: null,
                    model,
                })
            } else {
                await createDesktopTrigger(agentId, {
                    requestId: crypto.randomUUID(),
                    name,
                    description,
                    body,
                    methods,
                    connectionId: null,
                    provider: null,
                    model,
                })
            }
            if (alive.current) {
                setDirty(false)
                onDone()
            }
        } catch (err) {
            if (alive.current) setError(err instanceof Error ? err.message : 'Failed to save')
        } finally {
            if (alive.current) setSaving(false)
        }
    }, [agentId, slug, isEdit, trigger, name, description, methods, enabled, model, body, onDone])

    const handleRotate = useCallback(async () => {
        if (!slug || !trigger) return
        setRotating(true)
        setError(null)
        try {
            const next = await rotateDesktopTrigger(agentId, slug, crypto.randomUUID(), trigger.revision)
            if (alive.current) setTrigger(next)
        } catch (err) {
            if (alive.current) setError(err instanceof Error ? err.message : 'Failed to rotate the secret')
        } finally {
            if (alive.current) setRotating(false)
        }
    }, [agentId, slug, trigger])

    const handleDelete = useCallback(async () => {
        if (!slug || !trigger) return
        setDeleting(true)
        setError(null)
        try {
            await deleteDesktopTrigger(agentId, slug, crypto.randomUUID(), trigger.revision)
            if (alive.current) onDone()
        } catch (err) {
            if (alive.current) setError(err instanceof Error ? err.message : 'Failed to delete')
        } finally {
            if (alive.current) setDeleting(false)
        }
    }, [agentId, slug, trigger, onDone])

    if (loading) {
        return (
            <div className="p-3">
                <SkeletonRows rows={6} />
            </div>
        )
    }

    const canSave = name.trim() && body.trim() && methods.length > 0

    return (
        <PanelEditorShell>
            <PanelEditorHeader title={isEdit ? 'Edit trigger' : 'New trigger'} onBack={saving || deleting ? undefined : handleBack}>
                {isEdit && onShowHistory && (
                    <Button size="sm" variant="ghost" onClick={onShowHistory} disabled={saving || deleting}>
                        <HistoryIcon className="size-3.5 mr-1" /> History
                    </Button>
                )}
            </PanelEditorHeader>
            <PanelEditorBody>
                {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                <Input
                    label="Name"
                    helperText={isEdit ? "Name can't be changed (it sets the URL)." : 'The URL is derived from this name.'}
                    hideRequired
                    value={name}
                    onChange={e => { setDirty(true); setName(e.target.value) }}
                    disabled={isEdit || saving}
                    placeholder="GitHub push"
                    className="h-8 text-sm"
                />
                <Input
                    label="Description"
                    hideRequired
                    value={description}
                    onChange={e => { setDirty(true); setDescription(e.target.value) }}
                    disabled={saving}
                    placeholder="Fires when a commit lands on main"
                    className="h-8 text-sm"
                />

                {isEdit && trigger && (
                    <DesktopTriggerUrlField
                        agentId={agentId}
                        slug={trigger.slug}
                        token={trigger.token ?? ''}
                        rotating={rotating}
                        onRotate={handleRotate}
                        ingressAvailable={ingressAvailable}
                    />
                )}

                <Field label="Accepted methods" helperText={methods.includes('GET') ? 'GET is for services that can only call a plain URL. Link previews and browser visits are ignored.' : 'Most services send POST.'}>
                    <div className="flex flex-wrap gap-3">
                        {ALL_METHODS.map(method => (
                            <label key={method} className="flex items-center gap-1.5 text-xs cursor-pointer">
                                <Checkbox size="sm" checked={methods.includes(method)} disabled={saving} onCheckedChange={checked => toggleMethod(method, checked === true)} />
                                {method}
                            </label>
                        ))}
                    </div>
                </Field>

                <Field label="Model override" helperText="Leave empty to follow this coworker's configured local model. Hosted connection pickers are unavailable.">
                    <Input
                        hideRequired
                        value={model ?? ''}
                        onChange={e => { setDirty(true); setModel(e.target.value.trim() ? e.target.value : null) }}
                        disabled={saving}
                        placeholder="Follow coworker model"
                        className="h-8 text-sm"
                    />
                </Field>

                {isEdit && (
                    <Field orientation="row" label="Enabled">
                        <Switch checked={enabled} disabled={saving} onCheckedChange={value => { setDirty(true); setEnabled(value) }} />
                    </Field>
                )}

                <MarkdownTextarea
                    label="Trigger prompt"
                    dialogTitle="Edit the trigger prompt"
                    helperText="What the coworker runs when the URL is called (a fresh session each time). The caller payload is attached below it."
                    value={body}
                    onChange={value => { setDirty(true); setBody(value) }}
                    disabled={saving}
                    className="text-xs min-h-32 font-mono"
                    placeholder="A commit just landed. Review the diff in the payload and post a summary to Slack."
                />
            </PanelEditorBody>
            <PanelEditorFooter>
                {isEdit && (
                    <PanelDeleteButton
                        label="Delete trigger"
                        busy={deleting}
                        onClick={handleDelete}
                        confirmTitle={`Delete ${name || 'this trigger'}?`}
                        confirmDescription="Its webhook URL stops responding right away. Anything still calling it starts failing. Historical runs are kept."
                    />
                )}
                <Button size="sm" variant="outline" disabled={saving || deleting} onClick={handleBack}>Cancel</Button>
                <Button size="sm" className="flex-1" loading={saving} onClick={handleSave} disabled={!canSave || deleting}>
                    {isEdit ? 'Save changes' : 'Create trigger'}
                </Button>
            </PanelEditorFooter>
        </PanelEditorShell>
    )
}
