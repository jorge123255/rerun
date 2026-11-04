'use client'

import { FilePreview } from '@/components/files/FilePreview'
import { useFileContent } from '@/components/files/useFileContent'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ChevronLeftIcon, ChevronRightIcon } from '@/lib/icons'
import { useCallback } from 'react'

type ReadDesktopCardFile = (path: string) => Promise<{ content: string; truncated: boolean }>

/**
 * The Mac version of the original attachment lightbox. It keeps the same title bar, paging and
 * text preview, but has no raw URL and no download: a result card only opens this coworker's
 * existing text through the authenticated Files route.
 */
export function DesktopFileLightbox({ paths, names, index, readFile, onIndexChange, onClose }: {
    paths: readonly string[]
    names: readonly string[]
    index: number
    readFile: ReadDesktopCardFile
    onIndexChange: (index: number) => void
    onClose: () => void
}) {
    const path = paths[index]
    const name = names[index] ?? path.split('/').pop() ?? path
    const read = useCallback<ReadDesktopCardFile>(filePath => readFile(filePath), [readFile])
    const { content, loading, error, truncated } = useFileContent({ path, name, read })

    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent aria-describedby={undefined} className="flex h-[80vh] flex-col gap-0 p-0 sm:max-w-4xl">
                <div className="flex shrink-0 items-center gap-2 border-b border-border py-2 pl-4 pr-12">
                    <DialogTitle className="min-w-0 flex-1 truncate text-left font-mono text-xs font-normal text-muted-foreground">{name}</DialogTitle>
                    {paths.length > 1 && (
                        <>
                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                {index + 1} / {paths.length}
                            </span>
                            <Button size="icon-sm" variant="ghost" onClick={() => onIndexChange((index - 1 + paths.length) % paths.length)} aria-label="Previous attachment">
                                <ChevronLeftIcon className="size-4" />
                            </Button>
                            <Button size="icon-sm" variant="ghost" onClick={() => onIndexChange((index + 1) % paths.length)} aria-label="Next attachment">
                                <ChevronRightIcon className="size-4" />
                            </Button>
                        </>
                    )}
                </div>
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden pb-[env(safe-area-inset-bottom)] sm:pb-0">
                    {truncated && <p role="status" className="shrink-0 px-3 pt-3 text-xs text-muted-foreground">Preview shows the first 256 KB.</p>}
                    <div className="min-h-0 flex-1 overflow-hidden">
                        {error ? <p className="p-3 text-xs text-destructive">{error}</p> : <FilePreview fileName={name} content={content} rawUrl="" loading={loading} />}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
