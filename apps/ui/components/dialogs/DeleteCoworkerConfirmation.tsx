'use client'

import { useRef, useState, type ReactNode } from 'react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'

// The original coworker deletion confirmation, shared by the hosted and local boards.
export function DeleteCoworkerConfirmation({ agentName, children, open: controlledOpen, onOpenChange, onDelete, onRestoreFocus, description }: {
    agentName?: string
    children?: ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
    onDelete: (confirmationName: string) => void | Promise<void>
    onRestoreFocus?: () => void
    description?: ReactNode
}) {
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
    const [confirmText, setConfirmText] = useState('')
    const [busy, setBusy] = useState(false)
    const submitting = useRef(false)
    const [error, setError] = useState<string | null>(null)
    const open = controlledOpen ?? uncontrolledOpen
    const canDelete = !agentName || confirmText.trim() === agentName

    function handleOpenChange(next: boolean) {
        if (submitting.current) return
        if (controlledOpen === undefined) setUncontrolledOpen(next)
        onOpenChange?.(next)
        if (!next) { setConfirmText(''); setError(null) }
    }

    async function handleDelete() {
        if (!canDelete || submitting.current) return
        submitting.current = true
        setBusy(true)
        setError(null)
        try {
            await onDelete(confirmText.trim())
            submitting.current = false
            handleOpenChange(false)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not delete this coworker. Try again.')
        } finally {
            submitting.current = false
            setBusy(false)
        }
    }

    return <AlertDialog open={open} onOpenChange={handleOpenChange}>
        {children && <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>}
        <AlertDialogContent onCloseAutoFocus={onRestoreFocus ? event => { event.preventDefault(); onRestoreFocus() } : undefined}>
            <AlertDialogHeader>
                <AlertDialogTitle>Delete this coworker?</AlertDialogTitle>
                <AlertDialogDescription>
                    {description ?? 'This will permanently delete the coworker and its data on the engine. This action cannot be undone.'}
                </AlertDialogDescription>
            </AlertDialogHeader>
            {agentName && <div className="grid gap-2">
                <p className="text-sm text-muted-foreground">Type <span className="font-medium text-foreground">{agentName}</span> to confirm.</p>
                <Input aria-label="Coworker name to confirm deletion" value={confirmText} onChange={event => setConfirmText(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === 'Enter') { event.preventDefault(); void handleDelete() }
                    }} placeholder={agentName} disabled={busy} autoFocus />
            </div>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={event => { event.preventDefault(); void handleDelete() }} variant="destructive" disabled={!canDelete || busy}>
                    {busy ? 'Deleting…' : 'Delete'}
                </AlertDialogAction>
            </AlertDialogFooter>
        </AlertDialogContent>
    </AlertDialog>
}
