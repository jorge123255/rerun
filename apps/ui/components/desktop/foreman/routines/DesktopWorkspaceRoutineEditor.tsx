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
import { useDesktopLocale } from '../../DesktopLocale'
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
    const { t } = useDesktopLocale()
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
    const status = routine.lastResult?.status
    const resultLabel = status === 'done' || status === 'error' || status === 'cancelled' || status === 'running'
        ? t(`routines.status.${status}`)
        : status

    async function perform(action: () => Promise<void>) {
        if (externalChange || pending.current) return
        pending.current = true
        setBusy(true)
        setError('')
        try { await action() }
        catch (cause) { setError(cause instanceof Error ? cause.message : t('routines.requestFailed')) }
        finally { pending.current = false; setBusy(false) }
    }

    return <PanelEditorShell>
        <PanelEditorHeader title={t('routines.editor.titleEdit')} backLabel={t('routines.back')} onBack={busy ? undefined : onBack} />
        <PanelEditorBody>
            {externalChange && <div role="alert" className="space-y-2 text-xs text-destructive">
                <p>{t('routines.conflict')}</p>
                <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={onRefresh}>{t('routines.refresh')}</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={onKeep}>{t('routines.keepDraft')}</Button>
                </div>
            </div>}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <Field label={t('routines.editor.name')}><Input aria-label={t('routines.editor.name')} value={name} onChange={event => setName(event.target.value)} maxLength={120} disabled={busy} /></Field>
            <Field label={t('routines.editor.description')}><Input aria-label={t('routines.editor.description')} value={description} onChange={event => setDescription(event.target.value)} disabled={busy} /></Field>
            <DesktopScheduleDescription mode={mode} cron={cron} runAt={runAt} timezone={timezone}
                agentId={routine.agentId} connectionId={null} provider={null} model={null}
                routine={{ slug: routine.slug, revision: routine.revision }} disabled={busy || externalChange}
                onChange={next => { setMode(next.mode); setCron(next.cron ?? ''); setRunAt(next.runAt ?? ''); setTimezone(next.timezone) }} />
            <Field label={t('routines.scheduleType')}><select aria-label={t('routines.scheduleType')} value={mode} disabled={busy} onChange={event => setMode(event.target.value as 'cron' | 'runAt')}><option value="cron">{t('routines.recurring')}</option><option value="runAt">{t('routines.once')}</option></select></Field>
            {mode === 'cron' ? <Field label={t('routines.cron')}><Input aria-label={t('routines.cron')} value={cron} onChange={event => setCron(event.target.value)} disabled={busy} /></Field>
                : <Field label={t('routines.runAt')}><Input aria-label={t('routines.runAt')} value={runAt} onChange={event => setRunAt(event.target.value)} placeholder="2026-12-01T08:00:00-06:00" disabled={busy} /></Field>}
            <Field label={t('routines.editor.timezone')}><TimezoneCombobox value={timezone} onChange={setTimezone}
                placeholder={t('routines.timezone.placeholder')} searchPlaceholder={t('routines.timezone.search')} emptyLabel={t('routines.timezone.empty')} /></Field>
            <p className="text-xs text-muted-foreground">{t('routines.rawHelp')}</p>
            <Field orientation="row" label={t('routines.editor.enabled')}><Switch checked={enabled} disabled={busy} onCheckedChange={setEnabled} /></Field>
            {routine.slug && <DesktopTaskNotifyField agentId={routine.agentId} source="schedule" slug={routine.slug} disabled={busy} />}
            <MarkdownTextarea label={t('routines.editor.prompt')} dialogTitle={t('routines.editor.promptDialogTitle')} value={body} onChange={setBody} disabled={busy} />
            {resultLabel && <p className="text-xs">{t('routines.lastResult', { status: resultLabel })}</p>}
        </PanelEditorBody>
        <PanelEditorFooter>
            <Button size="sm" variant="outline" disabled={busy || externalChange || (routine.setupPending && !routine.enabled)} onClick={() => perform(() => onRun(routine))}>{t('routines.runNow')}</Button>
            <Button size="sm" disabled={busy || externalChange || !name.trim() || !body.trim()} onClick={() => perform(() => onSave({ name, description, body, enabled, timezone, cron: mode === 'cron' ? cron : null, runAt: mode === 'runAt' ? new Date(runAt).toISOString() : null }))}>{t('routines.editor.saveChanges')}</Button>
        </PanelEditorFooter>
    </PanelEditorShell>
}
