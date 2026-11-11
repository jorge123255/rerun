'use client'

import type { SaveFileResult } from '@/app/api/_services/file.service'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { XIcon } from '@/lib/icons'
import { Badge } from '@rerun/ui/primitives'
import { useCallback, useState } from 'react'

import { FileTextEditor } from './FileTextEditor'
import { useFileDraft } from './useFileDraft'
import type { FileDraftHost } from './useFileUnloadGuard'

type FileEditorDialogProps = {
    fileName: string
    initialContent: string
    onSave: (content: string, baseHash: string | null) => Promise<SaveFileResult>
    onSaved: (content: string) => void
    onClose: () => void
    host?: FileDraftHost
}

// Mounted only while editing, so it opens on content that has finished loading and unmounting it is
// what throws a draft away. Being modal is also what protects the draft: the panel behind cannot be
// navigated away, which unmounting it would do silently.
export function FileEditorDialog({ fileName, initialContent, onSave, onSaved, onClose, host }: FileEditorDialogProps) {
    const { draft, dirty, saving, error, conflict, setDraft, save, overwrite, dismissConflict } = useFileDraft({ initialContent, onSave, onSaved, host })
    const [confirmingDiscard, setConfirmingDiscard] = useState(false)

    const requestClose = useCallback(() => {
        if (saving) return
        if (dirty) setConfirmingDiscard(true)
        else onClose()
    }, [dirty, saving, onClose])

    return (
        // A dirty draft is not swipeable away on mobile either: the sheet only closes through the
        // paths that ask first.
        <Dialog open dismissible={!dirty} onOpenChange={open => !open && requestClose()}>
            <DialogContent
                aria-describedby={undefined}
                showCloseButton={false}
                className="flex h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
                // Radix focuses the content wrapper on open, which would undo the editor's autofocus.
                onOpenAutoFocus={event => event.preventDefault()}
            >
                <div className="flex shrink-0 items-center gap-2 border-b border-border py-2 pr-2 pl-4">
                    <DialogTitle className="min-w-0 flex-1 truncate text-left font-mono text-xs font-normal text-muted-foreground">{fileName}</DialogTitle>
                    {dirty && (
                        <Badge size="xs" tone="orange" glow={false}>
                            Unsaved
                        </Badge>
                    )}
                    <Button size="icon-sm" variant="ghost" onClick={requestClose} disabled={saving} title="Close editor" aria-label="Close editor">
                        <XIcon className="size-4" />
                    </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                    <FileTextEditor value={draft} onChange={setDraft} fileName={fileName} readOnly={saving} autoFocus onSave={save} />
                </div>
                {error && <p className="shrink-0 border-t border-border px-4 pt-2 text-xs text-destructive">{error}</p>}
                <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                    <Button size="sm" variant="outline" onClick={requestClose} disabled={saving}>
                        Cancel
                    </Button>
                    <TooltipDisabledReason reason={dirty ? undefined : 'No changes to save'}>
                        <Button size="sm" loading={saving} disabled={!dirty} onClick={save}>
                            Save changes
                        </Button>
                    </TooltipDisabledReason>
                </div>
            </DialogContent>
            {conflict && (
                <ConfirmDialog
                    open
                    onOpenChange={open => !open && dismissConflict()}
                    title={`${fileName} changed on the Box`}
                    description="Someone, or a coworker, wrote to this file after you opened it. Saving now replaces their version with yours."
                    confirmLabel="Overwrite"
                    cancelLabel="Keep theirs"
                    onConfirm={overwrite}
                />
            )}
            {confirmingDiscard && (
                <ConfirmDialog
                    open
                    onOpenChange={open => !open && setConfirmingDiscard(false)}
                    title="Discard your changes?"
                    description={`Your edits to ${fileName} are not saved yet. Closing the editor throws them away.`}
                    confirmLabel="Discard changes"
                    cancelLabel="Keep editing"
                    onConfirm={() => {
                        setConfirmingDiscard(false)
                        onClose()
                    }}
                />
            )}
        </Dialog>
    )
}
