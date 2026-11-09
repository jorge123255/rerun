'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { MarkdownTextarea } from '@/components/ui/markdown-textarea'
import { Switch } from '@/components/ui/switch'
import { PanelEditorBody, PanelEditorFooter, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { TimezoneCombobox } from '@/components/agent/TimezoneCombobox'
import type { DesktopScheduleEditInput, DesktopWorkspaceRoutine } from '../../../../../../packages/contracts/src/desktop-workspace-routines'
import { DesktopScheduleDescription } from '../../schedules/DesktopScheduleDescription'
import { DesktopTaskNotifyField } from '../../DesktopTaskNotifyField'

export function DesktopWorkspaceRoutineEditor({ routine, externalChange, onBack, onSave, onRun, onRefresh, onKeep }: {
    routine: DesktopWorkspaceRoutine
    externalChange: boolean
    onBack: () => void
    onSave: (input: DesktopScheduleEditInput) => Promise<void>
    onRun: (routine: DesktopWorkspaceRoutine) => Promise<void>
    onRefresh: () => void
    onKeep: () => void
}) {
    const [name, setName] = useState(routine.name)
    const [description, setDescription] = useState(routine.description)
    const [body, setBody] = useState(routine.body)
    const [mode, setMode] = useState<'cron' | 'runAt'>(routine.runAt ? 'runAt' : 'cron')
    const [cron, setCron] = useState(routine.cron ?? '0 8 * * *')
    const [runAt, setRunAt] = useState(routine.runAt ?? '')
    const [timezone, setTimezone] = useState(routine.timezone)
    const [enabled, setEnabled] = useState(routine.enabled)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const pending = useRef(false)

    async function perform(action: () => Promise<void>) {
        if (externalChange || pending.current) return
        pending.current = true
        setBusy(true)
        setError('')
        try { await action() }
        catch (cause) { setError(cause instanceof Error ? cause.message : 'Task request failed') }
        finally { pending.current = false; setBusy(false) }
    }

    return <PanelEditorShell>
        <PanelEditorHeader title="Edit task" onBack={busy ? undefined : onBack} />
        <PanelEditorBody>
            {externalChange && <div role="alert" className="space-y-2 text-xs text-destructive">
                <p>This routine changed while you were editing. Your text is kept here. Refresh to replace it with the latest routine, or keep your draft before saving.</p>
                <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={onRefresh}>Refresh from latest</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={onKeep}>Keep my draft</Button>
                </div>
            </div>}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <Field label="Name"><Input aria-label="Name" value={name} onChange={event => setName(event.target.value)} maxLength={120} disabled={busy} /></Field>
            <Field label="Description"><Input aria-label="Description" value={description} onChange={event => setDescription(event.target.value)} disabled={busy} /></Field>
            <DesktopScheduleDescription mode={mode} cron={cron} runAt={runAt} timezone={timezone}
                agentId={routine.agentId} connectionId={null} provider={null} model={null}
                routine={{ slug: routine.slug, revision: routine.revision }} disabled={busy || externalChange}
                onChange={next => { setMode(next.mode); setCron(next.cron ?? ''); setRunAt(next.runAt ?? ''); setTimezone(next.timezone) }} />
            <Field label="Schedule type"><select aria-label="Schedule type" value={mode} disabled={busy} onChange={event => setMode(event.target.value as 'cron' | 'runAt')}><option value="cron">Recurring</option><option value="runAt">Once</option></select></Field>
            {mode === 'cron' ? <Field label="Cron expression"><Input aria-label="Cron expression" value={cron} onChange={event => setCron(event.target.value)} disabled={busy} /></Field>
                : <Field label="Run at (ISO timestamp with timezone)"><Input aria-label="Run at (ISO timestamp with timezone)" value={runAt} onChange={event => setRunAt(event.target.value)} placeholder="2026-12-01T08:00:00-06:00" disabled={busy} /></Field>}
            <Field label="Timezone"><TimezoneCombobox value={timezone} onChange={setTimezone} /></Field>
            <p className="text-xs text-muted-foreground">Raw cron and ISO time remain available. The preview uses this routine’s saved model selection.</p>
            <Field orientation="row" label="Enabled"><Switch checked={enabled} disabled={busy} onCheckedChange={setEnabled} /></Field>
            {routine.slug && <DesktopTaskNotifyField agentId={routine.agentId} source="schedule" slug={routine.slug} disabled={busy} />}
            <MarkdownTextarea label="Task prompt" dialogTitle="Edit the task prompt" value={body} onChange={setBody} disabled={busy} />
            {routine.lastResult && <p className="text-xs">Last result: {routine.lastResult.status}</p>}
        </PanelEditorBody>
        <PanelEditorFooter>
            <Button size="sm" variant="outline" disabled={busy || externalChange || (routine.setupPending && !routine.enabled)} onClick={() => perform(() => onRun(routine))}>Run now</Button>
            <Button size="sm" disabled={busy || externalChange || !name.trim() || !body.trim()} onClick={() => perform(() => onSave({ name, description, body, enabled, timezone, cron: mode === 'cron' ? cron : null, runAt: mode === 'runAt' ? new Date(runAt).toISOString() : null }))}>Save changes</Button>
        </PanelEditorFooter>
    </PanelEditorShell>
}
