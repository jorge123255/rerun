'use client'

import { useDesktopLocale } from './DesktopLocale'
import type { desktopTranslator } from '@/lib/desktop/locale'
import { VERBOSITY_LEVELS } from '@rerun/contracts'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { useFileUnloadGuard } from '@/components/files/useFileUnloadGuard'
import { DeleteCoworkerConfirmation } from '@/components/dialogs/DeleteCoworkerConfirmation'
import { RenameAgentDialog } from '@/components/dialogs/RenameAgentDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { MarkdownTextarea } from '@/components/ui/markdown-textarea'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import type { DesktopCoworkerSettings as Settings } from '@/lib/desktop/coworker-settings'
import { FxSettingsLoading } from './fx-repairs/PanelLoadingSkeletons'
import type { DesktopAgentView } from './DesktopApp'
import { desktopFileDraftHost, holdDraftAdmission, isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { useDesktopDialogControl, useDesktopPanelCloseGuard, type DesktopDialogControl, type RegisterDesktopPanelCloseGuard } from '@/lib/desktop/use-dialog-control'
import { DesktopNotificationsDialog } from './DesktopNotificationsDialog'
import type { DesktopConversationOverviewAuthority } from './coworker-overview/conversation-mount'

type SettingsAuthority = Pick<DesktopConversationOverviewAuthority, 'identity' | 'canManage' | 'onRename' | 'onDelete'>
type ManagementAction = 'rename' | 'notifications' | 'delete'

function CoworkerManagement({ agent, authority, disabled, children }: {
    agent: DesktopAgentView
    authority?: SettingsAuthority
    disabled: boolean
    children: ReactNode
}) {
    const { t } = useDesktopLocale()
    const [action, setAction] = useState<ManagementAction | null>(null)
    const trigger = useRef<HTMLButtonElement | null>(null)
    const management = authority?.identity.agentId === agent.id ? authority : undefined
    const canManage = management?.canManage === true && !disabled

    function openAction(next: ManagementAction, event: MouseEvent<HTMLButtonElement>) {
        trigger.current = event.currentTarget
        setAction(next)
    }

    function changeOpen(next: boolean) {
        if (!next) setAction(null)
    }

    function restoreFocus() {
        if (trigger.current?.isConnected) trigger.current.focus()
    }

    return <>
        <Field orientation="row" label={t('coworker.name')}>
            <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm">{agent.name}</span>
                {management?.onRename && <Button type="button" variant="outline" size="sm" disabled={!canManage}
                    onClick={event => openAction('rename', event)}>{t('coworker.rename')}</Button>}
            </div>
        </Field>
        {children}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
            <Button type="button" variant="outline" size="sm" disabled={disabled}
                onClick={event => openAction('notifications', event)}>{t('notifications')}</Button>
            {management?.onDelete && <Button type="button" variant="destructive" size="sm" disabled={!canManage}
                onClick={event => openAction('delete', event)}>{t('coworker.delete')}</Button>}
        </div>
        {action === 'rename' && management?.onRename && <RenameAgentDialog agent={agent} open
            onOpenChange={changeOpen} onRestoreFocus={restoreFocus} labels={{
                title: t('coworker.renameTitle'), description: t('coworker.renameDescription'), name: t('coworker.name'),
                required: t('coworker.nameRequired'), tooLong: t('coworker.nameTooLong', { max: 60 }),
                failed: t('coworker.renameFailed'), cancel: t('cancel'), submit: t('coworker.rename'),
            }} onRename={async (_id, name) => {
                if (!canManage) throw new Error(t('coworker.renameFailed'))
                await management.onRename?.(management.identity, name)
            }} />}
        {action === 'notifications' && <DesktopNotificationsDialog open onOpenChange={changeOpen} pinnedCoworkerId={agent.id}
            onCloseAutoFocus={event => { event.preventDefault(); restoreFocus() }} />}
        {action === 'delete' && management?.onDelete && <DeleteCoworkerConfirmation agentName={agent.name} open
            onOpenChange={changeOpen} onRestoreFocus={restoreFocus} description={t('coworker.deleteDescription')} labels={{
                title: t('coworker.deleteTitle'), input: t('coworker.deleteInput'),
                confirm: name => <>{t.rich('coworker.deleteConfirm', { name, b: chunks => <span className="font-medium text-foreground">{chunks}</span> })}</>,
                failed: t('coworker.deleteFailed'), cancel: t('cancel'), deleting: t('coworker.deleting'), submit: t('coworker.delete'),
            }} onDelete={async name => {
                if (!canManage) throw new Error(t('coworker.deleteFailed'))
                await management.onDelete?.(management.identity, name)
            }} />}
    </>
}

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

export function DesktopCoworkerSettingsBody({ agent, authority, disabled, registerCloseGuard, onDone }: {
    agent: DesktopAgentView
    authority?: SettingsAuthority
    disabled: boolean
    registerCloseGuard: RegisterDesktopPanelCloseGuard
    onDone?: () => void
}) {
    const { t } = useDesktopLocale()
    const fieldId = useId()
    const replyLengths = VERBOSITY_LEVELS.map(value => ({ value, label: t(`coworker.${value}`) }))
    const recallHelp = t('coworker.recallHelp')
    const url = `/api/desktop/agents/${encodeURIComponent(agent.id)}/settings`
    const [settings, setSettings] = useState<Settings | null>(null)
    const [draft, setDraft] = useState<Settings | null>(null)
    const [error, setError] = useState('')
    const savingNow = useRef(false)
    const [saving, setSaving] = useState(false)
    const [pendingClose, setPendingClose] = useState<(() => void) | null>(null)
    const [attempt, setAttempt] = useState(0)

    useEffect(() => {
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
    }, [url, attempt, t])

    const instructionsChanged = settings?.soulEditable && draft?.soul.trim() !== settings.soul.trim()
    const lengthChanged = draft?.verbosity !== settings?.verbosity
    const suggestionsChanged = draft?.suggestedReplies !== settings?.suggestedReplies
    const memoryChanged = draft?.memoryEnabled !== settings?.memoryEnabled
    const learningChanged = draft?.autoMemory !== settings?.autoMemory
    const dirty = !!draft && (lengthChanged || instructionsChanged || memoryChanged || learningChanged || suggestionsChanged)
    const canSave = !disabled && dirty && (!instructionsChanged || !!draft.soul.trim())
    useFileUnloadGuard(dirty, desktopFileDraftHost())
    const guardClose = useCallback((close: () => void) => {
        if (savingNow.current) return
        if (dirty) setPendingClose(() => close)
        else close()
    }, [dirty])
    useLayoutEffect(() => registerCloseGuard(guardClose), [registerCloseGuard, guardClose])

    const learningAvailable = !!draft?.memoryEnabled && draft.selfImprovementEnabled

    async function save(event: FormEvent) {
        event.preventDefault()
        if (!draft || !canSave || savingNow.current || isDesktopQuitting()) return
        savingNow.current = true
        const release = holdDraftAdmission()
        setSaving(true)
        setError('')
        try {
            const saved = await requestSettings(url, {
                method: 'PATCH', signal: AbortSignal.timeout(20_000),
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    ...(instructionsChanged && { soul: draft.soul }),
                    ...(lengthChanged && { verbosity: draft.verbosity }),
                    ...(memoryChanged && { memoryEnabled: draft.memoryEnabled }),
                    ...(learningChanged && { autoMemory: draft.autoMemory }),
                    ...(suggestionsChanged && { suggestedReplies: draft.suggestedReplies }),
                }),
            }, t('coworker.saveFailed'))
            setSettings(saved)
            setDraft(saved)
            onDone?.()
            toast.success(t('coworker.saved'))
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t('coworker.saveFailed'))
        } finally {
            savingNow.current = false
            setSaving(false)
            release()
        }
    }

    const content = <>
        <CoworkerManagement key={agent.id} agent={agent} authority={authority} disabled={disabled || saving}>
            <form className="space-y-4" onSubmit={save}>
                {settings && draft ? <fieldset disabled={saving || disabled} className="min-w-0 space-y-4">
                    {settings.soulEditable ? <MarkdownTextarea label={t('coworker.instructions')} dialogTitle={t('coworker.instructionsEditor')} hideRequired
                        className="min-h-36 font-mono text-xs" disabled={saving || disabled} value={draft.soul} onChange={soul => setDraft({ ...draft, soul })} required />
                        : <p className="text-sm text-muted-foreground">{t('coworker.instructionsLocked')}</p>}
                    <fieldset className="min-w-0 space-y-2">
                        <legend className="text-sm font-medium">{t('coworker.replyLength')}</legend>
                        <Segmented options={replyLengths} value={draft.verbosity} onChange={verbosity => setDraft({ ...draft, verbosity })} />
                    </fieldset>
                    <Field orientation="row" label={t('coworker.suggested')} htmlFor={fieldId + '-suggested'} helperText={t('coworker.suggestedHelp')}>
                        <Switch id={fieldId + '-suggested'} checked={draft.suggestedReplies} onCheckedChange={suggestedReplies => setDraft({ ...draft, suggestedReplies })} />
                    </Field>
                    <fieldset className="min-w-0 space-y-3">
                        <legend className="text-sm font-medium">{t('coworker.memory')}</legend>
                        <Field orientation="row" label={t('coworker.recall')} htmlFor={fieldId + '-memory'} helperText={recallHelp}>
                            <Switch id={fieldId + '-memory'} checked={draft.memoryEnabled} aria-description={recallHelp}
                                onCheckedChange={memoryEnabled => setDraft({ ...draft, memoryEnabled })} />
                        </Field>
                        <Field orientation="row" label={t('coworker.learning')} htmlFor={fieldId + '-learning'} helperText={learningHelp(draft, t)}>
                            <Switch id={fieldId + '-learning'} checked={learningAvailable && draft.autoMemory} disabled={!learningAvailable}
                                aria-description={learningHelp(draft, t)} onCheckedChange={autoMemory => setDraft({ ...draft, autoMemory })} />
                        </Field>
                    </fieldset>
                </fieldset> : !error && <FxSettingsLoading />}
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <DialogFooter>
                    {(onDone || dirty) && <Button type="button" variant="outline" disabled={saving} onClick={() => {
                        if (onDone) onDone()
                        else { setDraft(settings); setError('') }
                    }}>{t('cancel')}</Button>}
                    {error && !draft ? <Button type="button" onClick={() => { setError(''); setAttempt(n => n + 1) }}>{t('coworker.retry')}</Button>
                        : <Button type="submit" disabled={!canSave || saving}>{t(saving ? 'coworker.saving' : 'coworker.save')}</Button>}
                </DialogFooter>
            </form>
        </CoworkerManagement>
        {pendingClose && <ConfirmDialog open onOpenChange={open => { if (!open) setPendingClose(null) }}
            title={t('coworker.discardTitle')} description={t('coworker.discardDescription')}
            confirmLabel={t('coworker.discard')} cancelLabel={t('coworker.keepEditing')}
            onConfirm={() => { setPendingClose(null); pendingClose() }} />}
    </>
    if (!onDone) return content
    return <DialogContent className="sm:max-w-xl" showCloseButton={!saving}
        onEscapeKeyDown={event => { if (savingNow.current) event.preventDefault() }}
        onInteractOutside={event => { if (savingNow.current) event.preventDefault() }}>
        <DialogHeader>
            <DialogTitle>{t('coworker.edit')}</DialogTitle>
            <DialogDescription>{t('coworker.editDescription', { name: agent.name })}</DialogDescription>
        </DialogHeader>
        {content}
    </DialogContent>
}

export function DesktopCoworkerSettings({ agent, authority, disabled, dialogControl }: {
    agent: DesktopAgentView
    authority?: SettingsAuthority
    disabled: boolean
    dialogControl?: DesktopDialogControl
}) {
    const { t } = useDesktopLocale()
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    const { register, requestClose } = useDesktopPanelCloseGuard()
    return <Dialog open={open} onOpenChange={next => {
        if (next) setOpen(true)
        else requestClose(() => setOpen(false))
    }} asSheet={false}>
        <DialogTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={disabled}>{t('coworker.edit')}</Button>
        </DialogTrigger>
        {open && <DesktopCoworkerSettingsBody key={agent.id} agent={agent} authority={authority} disabled={disabled}
            registerCloseGuard={register} onDone={() => setOpen(false)} />}
    </Dialog>
}
