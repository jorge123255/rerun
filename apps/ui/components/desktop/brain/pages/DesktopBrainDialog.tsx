'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { BrainIcon } from '@/lib/icons'
import { flushDesktopBrainDrafts } from '@/lib/desktop/use-brain-page-draft'
import { hydrateBrainUiState } from '@/lib/desktop/brain-ui-state'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useDesktopLocale } from '../../DesktopLocale'
import { DesktopBrainPanel } from './DesktopBrainPanel'
import type { DesktopBrainActions, DesktopBrainRoute } from './types'

/**
 * The panel in a dialog, with the close path this build already expects: a close flushes the page
 * that is being edited first, and refuses to close when a write could not land, so no keystroke is
 * dropped by a dismissal. Quit is covered by the same drafts through `subscribeDraftShutdown`.
 */
export function DesktopBrainDialog({ actions, dialogControl, hideTrigger = false, renderProposals, triggerLabel, refreshKey, openProposalsKey, openSlug, onOpenConsumed, route, onRouteConsumed, workspaceId }: {
    actions: DesktopBrainActions
    dialogControl?: DesktopDialogControl
    hideTrigger?: boolean
    renderProposals?: () => ReactNode
    triggerLabel?: string
    refreshKey?: number
    openProposalsKey?: number
    openSlug?: string | null
    onOpenConsumed?: () => void
    /** Root can pass a section or a table later. Absent until that wiring lands. */
    route?: DesktopBrainRoute | null
    onRouteConsumed?: () => void
    /** The active runtime workspace for shared file actions. */
    workspaceId?: number | null
}) {
    const { t } = useDesktopLocale()
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    const [closing, setClosing] = useState(false)
    const [ready, setReady] = useState(false)
    const [restoreError, setRestoreError] = useState<string | null>(null)
    const [restoreAttempt, setRestoreAttempt] = useState(0)
    useEffect(() => {
        if (!open) return
        let cancelled = false
        void hydrateBrainUiState().then(() => { if (!cancelled) { setReady(true); setRestoreError(null) } })
            .catch(error => { if (!cancelled) setRestoreError(error instanceof Error ? error.message : '') })
        return () => { cancelled = true }
    }, [open, restoreAttempt])

    async function requestOpen(next: boolean) {
        if (next) { setOpen(true); return }
        if (!ready) { setOpen(false); return }
        if (closing) return
        setClosing(true)
        try {
            const flushed = await flushDesktopBrainDrafts()
            if (!flushed) {
                toast.error(t('brainDesktop.closeFailed'))
                return
            }
            setOpen(false)
        } finally {
            setClosing(false)
        }
    }

    return <Dialog open={open} onOpenChange={requestOpen} asSheet={false}>
        {!hideTrigger && <DialogTrigger asChild><Button type="button" variant="outline" size="sm">{triggerLabel ?? t('brainDesktop.title')}</Button></DialogTrigger>}
        {open && <DialogContent className="flex h-[85dvh] flex-col gap-0 p-0 sm:max-w-6xl">
            <DialogHeaderBar icon={BrainIcon} title={t('brainDesktop.title')} description={t('brainDesktop.description')} />
            {ready ? <DesktopBrainPanel actions={actions} onClose={() => { void requestOpen(false) }} renderProposals={renderProposals} refreshKey={refreshKey} openProposalsKey={openProposalsKey} openSlug={openSlug} onOpenConsumed={onOpenConsumed} route={route} onRouteConsumed={onRouteConsumed} workspaceId={workspaceId} />
                : <div className="p-6" role={restoreError === null ? 'status' : 'alert'}>{restoreError === null ? t('brainDesktop.restoring') : restoreError || t('brainDesktop.restoreFailed')}
                    {restoreError !== null && <Button size="sm" onClick={() => setRestoreAttempt(value => value + 1)}>{t('brain.workspace.retry')}</Button>}</div>}
        </DialogContent>}
    </Dialog>
}
