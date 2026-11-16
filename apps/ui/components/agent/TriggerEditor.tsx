'use client'

import { createTriggerAction, deleteTriggerAction, getTriggerAction, rotateTriggerTokenAction, updateTriggerAction } from '@/app/api/_actions/agent.actions'
import { PanelDeleteButton, PanelEditorBody, PanelEditorFooter, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { TaskNotifyField } from '@/components/agent/TaskNotifyField'
import { RunModelField, useRunModel } from '@/components/agent/RunModelField'
import { TriggerUrlField } from '@/components/agent/TriggerUrlField'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SkeletonRows } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { MarkdownTextarea } from '@/components/ui/markdown-textarea'
import type { EngineTrigger, EngineTriggerMethod } from '@/lib/engine/types'
import { HistoryIcon } from '@/lib/icons'
import { useCallback, useEffect, useState } from 'react'

const ALL_METHODS: EngineTriggerMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const DEFAULT_METHODS: EngineTriggerMethod[] = ['POST']

type TriggerEditorProps = {
    agentId: string
    slug?: string
    onDone: () => void
    onBack: () => void
    onShowHistory?: () => void
}

export function TriggerEditor({ agentId, slug, onDone, onBack, onShowHistory }: TriggerEditorProps) {
    const isEdit = !!slug
    const { pick, setPick, availableGroups, providerFor, agentModel } = useRunModel(agentId)
    const [loading, setLoading] = useState(isEdit)
    const [trigger, setTrigger] = useState<EngineTrigger | null>(null)
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [methods, setMethods] = useState<EngineTriggerMethod[]>(DEFAULT_METHODS)
    const [enabled, setEnabled] = useState(true)
    const [body, setBody] = useState('')
    const [saving, setSaving] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [rotating, setRotating] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!slug) return
        setLoading(true)
        getTriggerAction(agentId, slug)
            .then(t => {
                if (!t) return
                setTrigger(t)
                setName(t.name)
                setDescription(t.description ?? '')
                setMethods(t.methods.length ? t.methods : DEFAULT_METHODS)
                setEnabled(t.enabled ?? true)
                setPick({ connectionId: t.connectionId ?? null, model: t.model })
                setBody(t.body ?? '')
            })
            .finally(() => setLoading(false))
    }, [agentId, slug, setPick])

    const toggleMethod = useCallback((method: EngineTriggerMethod, checked: boolean) => {
        setMethods(current => {
            const next = checked ? [...current, method] : current.filter(m => m !== method)
            return next.length ? ALL_METHODS.filter(m => next.includes(m)) : current
        })
    }, [])

    const handleSave = useCallback(async () => {
        setSaving(true)
        setError(null)
        const provider = providerFor(pick)
        const result = isEdit
            ? await updateTriggerAction(agentId, slug!, { description, body, methods, enabled, connectionId: pick.connectionId, provider, model: pick.model })
            : await createTriggerAction(agentId, { name, description, body, methods, connectionId: pick.connectionId, provider, model: pick.model })
        setSaving(false)
        if (result.success) onDone()
        else setError(result.error ?? 'Failed to save')
    }, [agentId, slug, isEdit, name, description, methods, enabled, pick, body, onDone, providerFor])

    const handleRotate = useCallback(async () => {
        if (!slug) return
        setRotating(true)
        setError(null)
        const result = await rotateTriggerTokenAction(agentId, slug)
        setRotating(false)
        if (result.success && result.trigger) setTrigger(result.trigger)
        else setError(result.error ?? 'Failed to rotate the secret')
    }, [agentId, slug])

    const handleDelete = useCallback(async () => {
        if (!slug) return
        setDeleting(true)
        const result = await deleteTriggerAction(agentId, slug)
        setDeleting(false)
        if (result.success) onDone()
        else setError(result.error ?? 'Failed to delete')
    }, [agentId, slug, onDone])

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
            <PanelEditorHeader title={isEdit ? 'Edit trigger' : 'New trigger'} onBack={onBack}>
                {isEdit && onShowHistory && (
                    <Button size="sm" variant="ghost" onClick={onShowHistory}>
                        <HistoryIcon className="size-3.5 mr-1" /> History
                    </Button>
                )}
            </PanelEditorHeader>
            <PanelEditorBody>
                {error && <p className="text-xs text-destructive">{error}</p>}
                <Input label="Name" helperText={isEdit ? "Name can't be changed (it sets the URL)." : 'The URL is derived from this name.'} hideRequired value={name} onChange={e => setName(e.target.value)} disabled={isEdit} placeholder="GitHub push" className="h-8 text-sm" />
                <Input label="Description" hideRequired value={description} onChange={e => setDescription(e.target.value)} placeholder="Fires when a commit lands on main" className="h-8 text-sm" />

                {isEdit && trigger && <TriggerUrlField agentId={agentId} slug={trigger.slug} token={trigger.token} rotating={rotating} onRotate={handleRotate} />}

                <Field label="Accepted methods" helperText={methods.includes('GET') ? 'GET is for services that can only call a plain URL. Link previews and browser visits are ignored.' : 'Most services send POST.'}>
                    <div className="flex flex-wrap gap-3">
                        {ALL_METHODS.map(method => (
                            <label key={method} className="flex items-center gap-1.5 text-xs cursor-pointer">
                                <Checkbox size="sm" checked={methods.includes(method)} onCheckedChange={checked => toggleMethod(method, checked === true)} />
                                {method}
                            </label>
                        ))}
                    </div>
                </Field>

                <RunModelField id="trigger-model" value={pick} onChange={setPick} availableGroups={availableGroups} agentModel={agentModel} helperText="The model this trigger runs under when it fires. Requires the provider's API key." />

                {isEdit && (
                    <Field orientation="row" label="Enabled">
                        <Switch checked={enabled} onCheckedChange={setEnabled} />
                    </Field>
                )}

                {slug && <TaskNotifyField agentId={agentId} source="trigger" slug={slug} />}

                <MarkdownTextarea
                    label="Trigger prompt"
                    dialogTitle="Edit the trigger prompt"
                    helperText="What the coworker runs when the URL is called (a fresh session each time). The caller payload is attached below it."
                    value={body}
                    onChange={setBody}
                    className="text-xs min-h-32 font-mono"
                    placeholder="A commit just landed. Review the diff in the payload and post a summary to Slack."
                />

            </PanelEditorBody>
            <PanelEditorFooter>
                {isEdit && <PanelDeleteButton
                        label="Delete trigger"
                        busy={deleting}
                        onClick={handleDelete}
                        confirmTitle={`Delete ${name || 'this trigger'}?`}
                        confirmDescription="Its webhook URL stops responding right away. Anything still calling it starts failing."
                    />}
                <Button size="sm" className="flex-1" loading={saving} onClick={handleSave} disabled={!canSave}>
                    {isEdit ? 'Save changes' : 'Create trigger'}
                </Button>
            </PanelEditorFooter>
        </PanelEditorShell>
    )
}
