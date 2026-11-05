'use client'

import { useState } from 'react'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { DownloadIcon, EllipsisIcon, Trash2Icon, UploadIcon } from '@/lib/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { DesktopPortableTemplateActions } from '@/lib/desktop/portable-template-actions'
import type { DesktopTemplateDetail } from './types'

export function DesktopTemplatePortableActions({
    template,
    actions,
    onLibraryChanged,
    onPickImport,
}: {
    template: DesktopTemplateDetail
    actions: DesktopPortableTemplateActions
    onLibraryChanged: () => void
    onPickImport?: () => Promise<{ uploadId: string } | null>
}) {
    const [busy, setBusy] = useState<'export' | 'import' | 'delete' | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [note, setNote] = useState<string | null>(null)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const canManage = Boolean(template.capturedAt && template.revision)

    async function runExport() {
        if (!canManage || busy) return
        setBusy('export')
        setError(null)
        setNote(null)
        try {
            const result = await actions.exportTemplate({ templateId: template.templateId, revision: template.revision })
            if (!result.ok) {
                setError(result.error)
                return
            }
            if (result.result.status === 'uncertain') {
                setError(result.result.reason)
                return
            }
            setNote(`Exported ${result.result.fileName}. Root opens the owned download artifact; files already saved outside the app stay owned by the user.`)
            onLibraryChanged()
        } finally {
            setBusy(null)
        }
    }

    async function runImport() {
        if (!onPickImport || busy) return
        setBusy('import')
        setError(null)
        setNote(null)
        try {
            const picked = await onPickImport()
            if (!picked) return
            const result = await actions.importPackage({ uploadId: picked.uploadId })
            if (!result.ok) {
                setError(result.error)
                return
            }
            if (result.result.status === 'uncertain') {
                setError(result.result.reason)
                return
            }
            setNote(`Imported “${result.result.provenance.sourceTitle}” as a new local library template. Setup stays unanswered until the owner completes it.`)
            onLibraryChanged()
        } finally {
            setBusy(null)
        }
    }

    async function runDelete() {
        if (!canManage || busy) return
        setBusy('delete')
        setError(null)
        setNote(null)
        try {
            const result = await actions.deleteTemplate({ templateId: template.templateId, revision: template.revision })
            if (!result.ok) {
                setError(result.error)
                return
            }
            if (result.result.status === 'uncertain') {
                setError(result.result.reason)
                return
            }
            setNote('Removed from the local library. Installed coworkers and their chats were left intact.')
            onLibraryChanged()
        } finally {
            setBusy(null)
            setDeleteOpen(false)
        }
    }

    return <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" className="gap-1.5" loading={busy === 'export'} disabled={!canManage || busy !== null} onClick={() => void runExport()}>
                <DownloadIcon className="size-3.5" />Export
            </Button>
            {onPickImport && <Button type="button" variant="outline" size="sm" className="gap-1.5" loading={busy === 'import'} disabled={busy !== null} onClick={() => void runImport()}>
                <UploadIcon className="size-3.5" />Import
            </Button>}
            <ConfirmDialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                title={`Delete “${template.title}” from this library?`}
                description="Only the local library entry and its owned package revision are removed. Installed coworkers and their chats stay. Files already saved outside the app are not deleted."
                confirmLabel="Delete from library"
                pending={busy === 'delete'}
                onConfirm={() => { void runDelete() }}
            />
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="More template actions" disabled={busy !== null}>
                        <EllipsisIcon className="size-3.5" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem disabled={!canManage || busy !== null} onSelect={() => void runExport()}>Export portable package</DropdownMenuItem>
                    {onPickImport && <DropdownMenuItem disabled={busy !== null} onSelect={() => void runImport()}>Import portable package</DropdownMenuItem>}
                    <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        disabled={!canManage || busy !== null}
                        onSelect={() => setDeleteOpen(true)}
                    >
                        <Trash2Icon className="size-3.5" />Delete from library
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {note && <p role="status" className="text-xs text-muted-foreground">{note}</p>}
        {template.portable && <p className="text-[11px] text-muted-foreground">
            Fidelity: {template.portable.binaryAssets ? 'includes binary assets' : 'no binary assets'}; {template.portable.userSkillTrees ? 'includes user skills' : 'no user skills'}.
            {template.portable.notes[0] ? ` ${template.portable.notes[0]}` : ''}
        </p>}
    </div>
}
