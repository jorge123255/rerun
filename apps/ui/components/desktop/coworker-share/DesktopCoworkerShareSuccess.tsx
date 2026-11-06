'use client'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { DownloadIcon, Trash2Icon } from '@/lib/icons'
import type { DesktopCoworkerExportedShare } from './useDesktopCoworkerShareFlow'

export function DesktopCoworkerShareSuccess({ exported, downloadUrl, onPreviewImport, onWithdraw, onRecoverWithdrawal, pendingRevocations, withdrawn, busy, onDone }: {
    exported: DesktopCoworkerExportedShare
    downloadUrl: string
    onPreviewImport: () => void
    onWithdraw: () => void
    onRecoverWithdrawal: () => void
    pendingRevocations: unknown[]
    withdrawn: boolean
    busy: boolean
    onDone: () => void
}) {
    const snapshotId = exported.result.manifest.packageKey
    const fileName = `coworker-${snapshotId.slice(0, 8)}.tar.gz`
    return <div className="flex flex-col gap-4">
        <Field label="Portable file" helperText={exported.result.reused
            ? 'A portable file with these same answers already existed for this coworker, so Rerun returned it rather than creating a second copy.'
            : 'Download the file and send it to whoever should have a copy. They do not need an account yet. No hosted link or upload was created.'}>
            <code className="flex min-h-8 min-w-0 items-center truncate rounded-md border border-input bg-muted/40 px-3 font-mono text-xs">{fileName}</code>
        </Field>
        <p className="text-xs text-muted-foreground">Archive {exported.result.archiveBytes} bytes · SHA-256 <code className="break-all">{exported.result.archiveSha256}</code></p>
        {withdrawn ? <p role="status" className="text-xs text-muted-foreground">Local share withdrawn. Future downloads from Rerun are blocked. Files already saved or imported are unchanged.</p> : <div className="flex flex-wrap gap-2">
            <a href={downloadUrl} download={fileName} className={buttonVariants({ variant: 'outline', size: 'sm' })}><DownloadIcon className="size-3.5" />Download portable file</a>
            <Button type="button" variant="outline" size="sm" onClick={onPreviewImport}>Preview import</Button>
            <ConfirmDialog
                title="Withdraw this local share?"
                description="Rerun deletes its retained archive right away and refuses future downloads. Anyone who already downloaded or imported the coworker keeps theirs; files outside Rerun are not deleted."
                confirmLabel="Withdraw local share"
                pending={busy}
                onConfirm={onWithdraw}
            >
                <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-destructive hover:text-destructive" disabled={busy}><Trash2Icon className="size-3.5" />Withdraw local share</Button>
            </ConfirmDialog>
        </div>}
        {pendingRevocations.length > 0 && !withdrawn && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRecoverWithdrawal}>Recover withdrawal</Button>}
        <div className="flex justify-end"><Button type="button" onClick={onDone}>Done</Button></div>
    </div>
}
