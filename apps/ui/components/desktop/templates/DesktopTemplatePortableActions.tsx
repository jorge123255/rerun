'use client'

import { useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { DownloadIcon, EllipsisIcon, Trash2Icon, UploadIcon } from '@/lib/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { DesktopPortableTemplateActions } from '@/lib/desktop/portable-template-actions'
import type { DesktopTemplateDetail } from './types'

type Attempt = { requestId: string; uploadId?: string }

export function DesktopTemplatePortableActions({
    template,
    actions,
    onLibraryChanged,
    onPickImport,
    onSaveExport,
}: {
    template: DesktopTemplateDetail
    actions: DesktopPortableTemplateActions
    onLibraryChanged: () => void
    onPickImport?: () => Promise<{ uploadId: string; requestId?: string } | null>
    onSaveExport?: (artifactId: string) => Promise<{ saved: boolean }>
}) {
    const [busy, setBusy] = useState<'export' | 'import' | 'delete' | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [note, setNote] = useState<string | null>(null)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const running = useRef(false)
    const mounted = useRef(true)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    const attempts = useRef(new Map<string, Attempt>())
    const canManage = Boolean(template.capturedAt && template.revision)

    function attemptKey(kind: string) { return `rerun-portable-attempt:v1:${template.templateId}:${template.revision}:${kind}` }
    function savedAttempt(kind: string): Attempt | null {
        const key = attemptKey(kind)
        return attempts.current.get(key) ?? null
    }
    function remember(kind: string, attempt: Attempt) {
        const key = attemptKey(kind)
        attempts.current.set(key, attempt)
        return attempt
    }
    function forget(kind: string) {
        const key = attemptKey(kind)
        attempts.current.delete(key)
    }

    async function runExport() {
        if (!canManage || running.current) return
        running.current = true
        setBusy('export')
        setError(null)
        setNote(null)
        try {
            const attempt = remember('export', savedAttempt('export') ?? { requestId: crypto.randomUUID() })
            const result = await actions.exportTemplate({ templateId: template.templateId, revision: template.revision, requestId: attempt.requestId })
            if (!mounted.current) return
            if (!result.ok) {
                if (!result.uncertain) forget('export')
                setError(result.error)
                return
            }
            if (result.result.status === 'uncertain') {
                setError(result.result.reason)
                return
            }
            forget('export')
            if (onSaveExport) {
                const saved = await onSaveExport(result.result.artifactId)
                setNote(saved.saved ? 'Template package saved.' : 'Export ready. Choose Export to save the package.')
            } else setNote(`Exported ${result.result.fileName}.`)
        } catch {
            setError('Could not confirm the export. Try again to recover this attempt.')
        } finally {
            running.current = false
            setBusy(null)
        }
    }

    async function runImport() {
        if (!onPickImport || running.current) return
        running.current = true
        setBusy('import')
        setError(null)
        setNote(null)
        try {
            const previous = savedAttempt('import')
            const picked = previous?.uploadId ? { uploadId: previous.uploadId, requestId: previous.requestId } : await onPickImport()
            if (!picked) return
            const attempt = remember('import', previous?.uploadId ? previous : { requestId: picked.requestId ?? crypto.randomUUID(), uploadId: picked.uploadId })
            const result = await actions.importPackage({ uploadId: picked.uploadId, requestId: attempt.requestId })
            if (!mounted.current) return
            if (!result.ok) {
                if (!result.uncertain) forget('import')
                setError(result.error)
                return
            }
            if (result.result.status === 'uncertain') {
                setError(result.result.reason)
                return
            }
            forget('import')
            setNote(`Imported “${result.result.provenance.sourceTitle}” into your library.`)
            onLibraryChanged()
        } catch {
            setError('Could not confirm the import. Try again to recover this attempt.')
        } finally {
            running.current = false
            setBusy(null)
        }
    }

    async function runDelete() {
        if (!canManage || running.current) return
        running.current = true
        setBusy('delete')
        setError(null)
        setNote(null)
        try {
            const attempt = remember('delete', savedAttempt('delete') ?? { requestId: crypto.randomUUID() })
            const result = await actions.deleteTemplate({ templateId: template.templateId, revision: template.revision, requestId: attempt.requestId })
            if (!mounted.current) return
            if (!result.ok) {
                if (!result.uncertain) forget('delete')
                setError(result.error)
                return
            }
            if (result.result.status === 'uncertain') {
                setError(result.result.reason)
                return
            }
            forget('delete')
            setNote('Removed from the library. Your installed coworkers and their chats are still available.')
            onLibraryChanged()
        } catch {
            setError('Could not confirm the deletion. Try again to recover this attempt.')
        } finally {
            running.current = false
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
