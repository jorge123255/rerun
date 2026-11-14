'use client'

import type { FileEntry } from '@/app/api/_actions/workspace-file.actions'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { FileUploadMenu } from '@/components/ui/file-upload-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { formatBytes } from '@/lib/files/format'
import { useFileTranslations } from '@/lib/files/translations'
import { entriesFromDataTransfer, type UploadEntry } from '@/lib/files/upload'
import { DownloadIcon, EllipsisIcon, FileIcon, FolderIcon, PencilIcon, Trash2Icon } from '@/lib/icons'
import { useEffect, useRef, useState, type DragEvent } from 'react'

type FileListProps = {
    title: string
    // Undefined while the folder is still being listed.
    entries: FileEntry[] | undefined
    onOpen: (entry: FileEntry) => void
    onRename?: (name: string, next: string, entry: FileEntry) => void
    canRename?: (entry: FileEntry) => boolean
    onDelete?: (name: string, entry: FileEntry) => void
    canDelete?: (entry: FileEntry) => boolean
    deleteDescription?: { file: string; folder: string }
    onDownload?: (name: string, entry: FileEntry) => void
    canDownload?: (entry: FileEntry) => boolean
    downloadLabel?: string
    onUpload: (entries: UploadEntry[]) => void
    emptyDescription?: string
    uploadDisabled?: boolean
}

function kindLabel(entry: FileEntry, labels: { folder: string; file: string }): string {
    if (entry.type === 'dir') return labels.folder
    const dot = entry.name.lastIndexOf('.')
    return dot > 0 ? entry.name.slice(dot + 1).toUpperCase() : labels.file
}

function RenameField({ name, directory, onSubmit, onCancel }: { name: string; directory: boolean; onSubmit: (next: string) => void; onCancel: () => void }) {
    const t = useFileTranslations()
    const [value, setValue] = useState(name)
    const ref = useRef<HTMLInputElement>(null)
    const settled = useRef(false)

    useEffect(() => {
        const input = ref.current
        if (!input) return
        input.focus()
        const dot = directory ? -1 : name.lastIndexOf('.')
        input.setSelectionRange(0, dot > 0 ? dot : name.length)
    }, [name, directory])

    const submit = () => {
        if (settled.current) return
        settled.current = true
        const next = value.trim()
        if (next && next !== name) onSubmit(next)
        else onCancel()
    }

    return (
        <Input
            ref={ref}
            value={value}
            aria-label={t('files.list.newName')}
            onChange={event => setValue(event.target.value)}
            onBlur={submit}
            onClick={event => event.stopPropagation()}
            onKeyDown={event => {
                event.stopPropagation()
                if (event.key === 'Enter') { event.preventDefault(); submit() }
                if (event.key === 'Escape') { event.preventDefault(); settled.current = true; onCancel() }
            }}
            className="h-7 px-2 text-sm"
        />
    )
}

function ListSkeleton() {
    return (
        <div className="space-y-1">
            {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="flex h-9 items-center gap-3 px-2">
                    <Skeleton className="size-4 rounded" />
                    <Skeleton className="h-3 w-1/3" />
                    <Skeleton className="ml-auto h-3 w-12" />
                </div>
            ))}
        </div>
    )
}

// A folder of the shared folder as Notion lists a database: the folder name as the page title, one
// line per entry, actions on hover, and the whole page as a drop zone.
export function FileList({ title, entries, onOpen, onRename, canRename, onDelete, canDelete, deleteDescription, onDownload, canDownload,
    downloadLabel, onUpload, emptyDescription, uploadDisabled = false }: FileListProps) {
    const t = useFileTranslations()
    const labels = { folder: t('files.list.folder'), file: t('files.list.file') }
    const [renaming, setRenaming] = useState<FileEntry | null>(null)
    const renameAfterClose = useRef<FileEntry | null>(null)
    const [deleting, setDeleting] = useState<FileEntry | null>(null)
    const [dragOver, setDragOver] = useState(false)

    const handleDrop = async (event: DragEvent) => {
        event.preventDefault()
        setDragOver(false)
        if (uploadDisabled) return
        const dropped = await entriesFromDataTransfer(event.dataTransfer)
        if (dropped.length) onUpload(dropped)
    }

    const acceptsDrop = (event: DragEvent) => event.dataTransfer.types.includes('Files')

    return (
        <div
            className="relative min-h-0 flex-1 overflow-y-auto"
            onDragOver={event => {
                if (uploadDisabled || !acceptsDrop(event)) return
                event.preventDefault()
                setDragOver(true)
            }}
            onDragLeave={event => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                setDragOver(false)
            }}
            onDrop={event => void handleDrop(event)}
        >
            {dragOver && (
                <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/50 bg-primary/5">
                    <p className="text-sm font-medium text-primary">{t('files.list.dropHere')}</p>
                </div>
            )}
            <div className="mx-auto w-full max-w-[900px] px-6 pb-16 pt-8 sm:px-12 sm:pt-12">
                <div className="mb-6 flex items-center gap-3">
                    <h1 className="min-w-0 flex-1 truncate text-[2rem] font-semibold leading-tight tracking-tight">{title}</h1>
                    <FileUploadMenu onPick={onUpload} disabled={uploadDisabled} />
                </div>

                <div className="grid grid-cols-[minmax(0,1fr)_5rem_4rem_2rem] items-center gap-x-3 border-b border-border px-2 pb-1.5 text-xs text-muted-foreground max-sm:grid-cols-[minmax(0,1fr)_2rem]">
                    <span>{t('files.list.name')}</span>
                    <span className="text-right max-sm:hidden">{t('files.list.size')}</span>
                    <span className="max-sm:hidden">{t('files.list.type')}</span>
                    <span />
                </div>

                {!entries ? (
                    <ListSkeleton />
                ) : entries.length === 0 ? (
                    <p className="px-2 py-6 text-sm text-muted-foreground">{emptyDescription ?? t('files.list.empty')}</p>
                ) : (
                    <div className="divide-y divide-border/60">
                        {entries.map(entry => {
                            const renameAllowed = Boolean(onRename) && (canRename?.(entry) ?? true)
                            const downloadAllowed = entry.type !== 'dir' && !!onDownload && (canDownload?.(entry) ?? true)
                            const Glyph = entry.type === 'dir' ? FolderIcon : FileIcon
                            return (
                                <div
                                    key={entry.name}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => renaming?.name !== entry.name && onOpen(entry)}
                                    onKeyDown={event => event.target === event.currentTarget && event.key === 'Enter' && renaming?.name !== entry.name && onOpen(entry)}
                                    className="group/file grid h-9 cursor-pointer grid-cols-[minmax(0,1fr)_5rem_4rem_2rem] items-center gap-x-3 rounded-md px-2 text-sm outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 max-sm:grid-cols-[minmax(0,1fr)_2rem]"
                                >
                                    <span className="flex min-w-0 items-center gap-2.5">
                                        <Glyph className="size-4 shrink-0 text-muted-foreground" />
                                        {renaming?.name === entry.name ? (
                                            <RenameField
                                                name={renaming.name}
                                                directory={renaming.type === 'dir'}
                                                onSubmit={next => {
                                                    setRenaming(null)
                                                    onRename?.(renaming.name, next, renaming)
                                                }}
                                                onCancel={() => setRenaming(null)}
                                            />
                                        ) : (
                                            <span className="truncate">{entry.name}</span>
                                        )}
                                    </span>
                                    <span className="text-right text-xs tabular-nums text-muted-foreground max-sm:hidden">{entry.type === 'dir' ? '' : formatBytes(entry.size)}</span>
                                    <span className="truncate text-xs text-muted-foreground max-sm:hidden">{kindLabel(entry, labels)}</span>
                                    {(renameAllowed || onDelete && (!canDelete || canDelete(entry)) || downloadAllowed) && <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                size="icon-xs"
                                                variant="ghost"
                                                aria-label={t('files.list.actionsFor', { name: entry.name })}
                                                onClick={event => event.stopPropagation()}
                                                className="opacity-0 transition-opacity group-hover/file:opacity-100 aria-expanded:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
                                            >
                                                <EllipsisIcon />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end" onClick={event => event.stopPropagation()}
                                            onCloseAutoFocus={event => {
                                                const selected = renameAfterClose.current
                                                if (selected?.name !== entry.name) return
                                                event.preventDefault()
                                                renameAfterClose.current = null
                                                setRenaming(selected)
                                            }}>
                                            {downloadAllowed && (
                                                <DropdownMenuItem onSelect={() => onDownload?.(entry.name, entry)}>
                                                    <DownloadIcon /> {downloadLabel ?? t('files.grid.download')}
                                                </DropdownMenuItem>
                                            )}
                                            {renameAllowed && <DropdownMenuItem onSelect={() => { renameAfterClose.current = entry }}>
                                                <PencilIcon /> {t('files.grid.rename')}
                                            </DropdownMenuItem>}
                                            {onDelete && (!canDelete || canDelete(entry)) && <><DropdownMenuSeparator />
                                            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(entry)}>
                                                <Trash2Icon /> {t('files.grid.delete')}
                                            </DropdownMenuItem></>}
                                        </DropdownMenuContent>
                                    </DropdownMenu>}
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>

            <ConfirmDialog
                open={deleting !== null}
                onOpenChange={open => !open && setDeleting(null)}
                title={t('files.delete.title', { name: deleting?.name ?? '' })}
                description={deleting?.type === 'dir' ? deleteDescription?.folder ?? t('files.delete.folder') : deleteDescription?.file ?? t('files.delete.file')}
                confirmLabel={t('files.grid.delete')}
                cancelLabel={t('files.editor.cancel')}
                onConfirm={() => {
                    if (deleting && (!canDelete || canDelete(deleting))) onDelete?.(deleting.name, deleting)
                    setDeleting(null)
                }}
            />
        </div>
    )
}
