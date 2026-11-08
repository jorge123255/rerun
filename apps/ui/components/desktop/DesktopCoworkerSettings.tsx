'use client'

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

const replyLengths = VERBOSITY_LEVELS.map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }))
const recallHelp = 'Include relevant saved notes when this coworker answers in chat.'

function learningHelp(settings: Settings) {
    if (!settings.selfImprovementEnabled) return 'Learning is paused because self-improvement is off for this coworker.'
    if (!settings.memoryEnabled) return 'Turn on saved memories in chat to change this preference.'
    return 'Save or update notes after a reply when this coworker learns something worth remembering.'
}

async function requestSettings(url: string, init: RequestInit): Promise<Settings> {
    const response = await fetch(url, init)
    if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(typeof body.error === 'string' ? body.error : 'Could not reach this coworker’s settings.')
    }
    return response.json()
}

export function DesktopCoworkerSettings({ agent, disabled, dialogControl }: { agent: DesktopAgentView; disabled: boolean; dialogControl?: DesktopDialogControl }) {
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
        void requestSettings(url, { cache: 'no-store', signal: controller.signal }).then(result => {
            if (!controller.signal.aborted) {
                setSettings(result)
                setDraft(result)
            }
        }).catch(cause => {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load coworker settings.')
        })
        return () => controller.abort()
    }, [open, url, attempt])

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
            })
            setOpen(false)
            toast.success('Coworker settings saved.')
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not save coworker settings.')
        } finally { setSaving(false) }
    }

    return <Dialog open={open} onOpenChange={changeOpen} asSheet={false}>
        <DialogTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={disabled}>Edit coworker</Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-xl" showCloseButton={!saving}>
            <DialogHeader>
                <DialogTitle>Edit coworker</DialogTitle>
                <DialogDescription>Set how {agent.name} should respond in its conversations.</DialogDescription>
            </DialogHeader>
            <form className="space-y-4" onSubmit={save}>
                {settings && draft ? <fieldset disabled={saving} className="min-w-0 space-y-4">
                    {settings.soulEditable ? <MarkdownTextarea label="Instructions" dialogTitle="Edit coworker instructions" hideRequired
                        className="min-h-36 font-mono text-xs" value={draft.soul} onChange={soul => setDraft({ ...draft, soul })} required />
                        : <p className="text-sm text-muted-foreground">This coworker’s instructions are locked.</p>}
                    <fieldset className="min-w-0 space-y-2">
                        <legend className="text-sm font-medium">Reply length</legend>
                        <Segmented options={replyLengths} value={draft.verbosity} onChange={verbosity => setDraft({ ...draft, verbosity })} />
                    </fieldset>
                    <Field orientation="row" label="Suggested replies" htmlFor="coworker-suggested-replies" helperText="Offer useful follow-up messages below replies.">
                        <Switch id="coworker-suggested-replies" checked={draft.suggestedReplies} onCheckedChange={suggestedReplies => setDraft({ ...draft, suggestedReplies })} />
                    </Field>
                    <fieldset className="min-w-0 space-y-3">
                        <legend className="text-sm font-medium">Memory</legend>
                        <Field orientation="row" label="Use saved memories in chat" htmlFor="coworker-memory-enabled" helperText={recallHelp}>
                            <Switch id="coworker-memory-enabled" checked={draft.memoryEnabled} aria-description={recallHelp}
                                onCheckedChange={memoryEnabled => setDraft({ ...draft, memoryEnabled })} />
                        </Field>
                        <Field orientation="row" label="Learn from replies" htmlFor="coworker-auto-memory" helperText={learningHelp(draft)}>
                            <Switch id="coworker-auto-memory" checked={learningAvailable && draft.autoMemory} disabled={!learningAvailable}
                                aria-description={learningHelp(draft)} onCheckedChange={autoMemory => setDraft({ ...draft, autoMemory })} />
                        </Field>
                    </fieldset>
                </fieldset> : !error && <FxSettingsLoading />}
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <DialogFooter>
                    <Button type="button" variant="outline" disabled={saving} onClick={() => changeOpen(false)}>Cancel</Button>
                    {error && !draft ? <Button type="button" onClick={() => { setError(''); setAttempt(n => n + 1) }}>Retry</Button>
                        : <Button type="submit" disabled={!canSave || saving}>{saving ? 'Saving…' : 'Save changes'}</Button>}
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>
}
