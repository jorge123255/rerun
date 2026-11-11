'use client'

import { useDesktopLocale } from './DesktopLocale'
import type { desktopTranslator } from '@/lib/desktop/locale'
import { VERBOSITY_LEVELS } from '@rerun/contracts'
import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { MarkdownTextarea } from '@/components/ui/markdown-textarea'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import type { DesktopCoworkerSettings as Settings } from '@/lib/desktop/coworker-settings'
import { FxSettingsLoading } from './fx-repairs/PanelLoadingSkeletons'
import type { DesktopAgentView } from './DesktopApp'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'


function learningHelp(settings: Settings, t: ReturnType<typeof desktopTranslator>) {
    if (!settings.selfImprovementEnabled) return t('coworker.learningPaused')
    if (!settings.memoryEnabled) return t('coworker.learningUnavailable')
    return t('coworker.learningHelp')
}

async function requestSettings(url: string, init: RequestInit, fallback: string): Promise<Settings> {
    const response = await fetch(url, init)
    if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(typeof body.error === 'string' ? body.error : fallback)
    }
    return response.json()
}

export function DesktopCoworkerSettings({ agent, disabled, dialogControl }: { agent: DesktopAgentView; disabled: boolean; dialogControl?: DesktopDialogControl }) {
    const { t } = useDesktopLocale()
    const replyLengths = VERBOSITY_LEVELS.map(value => ({ value, label: t(`coworker.${value}`) }))
    const recallHelp = t('coworker.recallHelp')
    const url = `/api/desktop/agents/${encodeURIComponent(agent.id)}/settings`
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    const [settings, setSettings] = useState<Settings | null>(null)
    const [draft, setDraft] = useState<Settings | null>(null)
    const [error, setError] = useState('')
    const [saving, setSaving] = useState(false)
    const [attempt, setAttempt] = useState(0)

    useEffect(() => {
        if (!open) return
        setSettings(null)
        setDraft(null)
        setError('')
        const controller = new AbortController()
        void requestSettings(url, { cache: 'no-store', signal: controller.signal }, t('coworker.loadFailed')).then(result => {
            if (!controller.signal.aborted) {
                setSettings(result)
                setDraft(result)
            }
        }).catch(cause => {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('coworker.loadFailed'))
        })
        return () => controller.abort()
    }, [open, url, attempt, t])

    function changeOpen(next: boolean) {
        if (saving) return
        setOpen(next)
        if (next) {
            setSettings(null)
            setDraft(null)
            setError('')
        }
    }

    const instructionsChanged = settings?.soulEditable && draft?.soul.trim() !== settings.soul.trim()
    const lengthChanged = draft?.verbosity !== settings?.verbosity
    const suggestionsChanged = draft?.suggestedReplies !== settings?.suggestedReplies
    const memoryChanged = draft?.memoryEnabled !== settings?.memoryEnabled
    const learningChanged = draft?.autoMemory !== settings?.autoMemory
    const canSave = !!draft && (lengthChanged || instructionsChanged || memoryChanged || learningChanged || suggestionsChanged) && (!instructionsChanged || !!draft.soul.trim())
    const learningAvailable = !!draft?.memoryEnabled && draft.selfImprovementEnabled

    async function save(event: FormEvent) {
        event.preventDefault()
        if (!draft || !canSave || saving) return
        setSaving(true)
        setError('')
        try {
            await requestSettings(url, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    ...(instructionsChanged && { soul: draft.soul }),
                    ...(lengthChanged && { verbosity: draft.verbosity }),
                    ...(memoryChanged && { memoryEnabled: draft.memoryEnabled }),
                    ...(learningChanged && { autoMemory: draft.autoMemory }),
                    ...(suggestionsChanged && { suggestedReplies: draft.suggestedReplies }),
                }),
            }, t('coworker.saveFailed'))
            setOpen(false)
            toast.success(t('coworker.saved'))
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t('coworker.saveFailed'))
        } finally { setSaving(false) }
    }

    return <Dialog open={open} onOpenChange={changeOpen} asSheet={false}>
        <DialogTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={disabled}>{t('coworker.edit')}</Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-xl" showCloseButton={!saving}>
            <DialogHeader>
                <DialogTitle>{t('coworker.edit')}</DialogTitle>
                <DialogDescription>{t('coworker.editDescription', { name: agent.name })}</DialogDescription>
            </DialogHeader>
            <form className="space-y-4" onSubmit={save}>
                {settings && draft ? <fieldset disabled={saving} className="min-w-0 space-y-4">
                    {settings.soulEditable ? <MarkdownTextarea label={t('coworker.instructions')} dialogTitle={t('coworker.instructionsEditor')} hideRequired
                        className="min-h-36 font-mono text-xs" value={draft.soul} onChange={soul => setDraft({ ...draft, soul })} required />
                        : <p className="text-sm text-muted-foreground">{t('coworker.instructionsLocked')}</p>}
                    <fieldset className="min-w-0 space-y-2">
                        <legend className="text-sm font-medium">{t('coworker.replyLength')}</legend>
                        <Segmented options={replyLengths} value={draft.verbosity} onChange={verbosity => setDraft({ ...draft, verbosity })} />
                    </fieldset>
                    <Field orientation="row" label={t('coworker.suggested')} htmlFor="coworker-suggested-replies" helperText={t('coworker.suggestedHelp')}>
                        <Switch id="coworker-suggested-replies" checked={draft.suggestedReplies} onCheckedChange={suggestedReplies => setDraft({ ...draft, suggestedReplies })} />
                    </Field>
                    <fieldset className="min-w-0 space-y-3">
                        <legend className="text-sm font-medium">{t('coworker.memory')}</legend>
                        <Field orientation="row" label={t('coworker.recall')} htmlFor="coworker-memory-enabled" helperText={recallHelp}>
                            <Switch id="coworker-memory-enabled" checked={draft.memoryEnabled} aria-description={recallHelp}
                                onCheckedChange={memoryEnabled => setDraft({ ...draft, memoryEnabled })} />
                        </Field>
                        <Field orientation="row" label={t('coworker.learning')} htmlFor="coworker-auto-memory" helperText={learningHelp(draft, t)}>
                            <Switch id="coworker-auto-memory" checked={learningAvailable && draft.autoMemory} disabled={!learningAvailable}
                                aria-description={learningHelp(draft, t)} onCheckedChange={autoMemory => setDraft({ ...draft, autoMemory })} />
                        </Field>
                    </fieldset>
                </fieldset> : !error && <FxSettingsLoading />}
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <DialogFooter>
                    <Button type="button" variant="outline" disabled={saving} onClick={() => changeOpen(false)}>{t('cancel')}</Button>
                    {error && !draft ? <Button type="button" onClick={() => { setError(''); setAttempt(n => n + 1) }}>{t('coworker.retry')}</Button>
                        : <Button type="submit" disabled={!canSave || saving}>{t(saving ? 'coworker.saving' : 'coworker.save')}</Button>}
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>
}
