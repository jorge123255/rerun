'use client'

import { FilePreview } from '@/components/files/FilePreview'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { FileCardEntry } from '@rerun/contracts'
import { ChevronLeftIcon, ChevronRightIcon } from '@/lib/icons'
import { useEffect, useRef, useState } from 'react'
import { DesktopCardError, isDesktopCardImage, readDesktopCardFile, readDesktopCardImage } from '@/lib/desktop/file-card'

type PreviewState =
    | { key: string; status: 'loading' }
    | { key: string; status: 'text'; content: string; truncated: boolean }
    | { key: string; status: 'image'; src: string }
    | { key: string; status: 'error'; message: string }

const loading = (key: string): PreviewState => ({ key, status: 'loading' })

function messageOf(error: unknown, image: boolean): string {
    // Preserve the text preview's generic failure; filesystem error details are not UI copy.
    if (!image) return 'This file could not be read.'
    return error instanceof DesktopCardError ? error.message : 'This image is no longer available.'
}

/**
 * The Mac version of the original attachment lightbox. It keeps the same title bar, paging and
 * preview, but has no raw URL and no download. Text uses the authenticated Files read route; an
 * image uses the authenticated image route and a released object URL. A replaced, deleted, animated
 * or damaged image shows its own unavailable state.
 */
export function DesktopFileLightbox({ agentId, files, index, onIndexChange, onClose }: {
    agentId: string
    files: readonly FileCardEntry[]
    index: number
    onIndexChange: (index: number) => void
    onClose: () => void
}) {
    const file = files[index]!
    const name = file.name
    const image = isDesktopCardImage(file.path)
    const key = `${agentId}\u0000${file.path}\u0000${file.identity ?? ''}\u0000${image ? 'image' : 'text'}`
    const [preview, setPreview] = useState<PreviewState>(() => loading(key))
    const current = preview.key === key ? preview : loading(key)
    const objectUrl = useRef<string | null>(null)

    useEffect(() => {
        const controller = new AbortController()
        let active = true
        setPreview(loading(key))
        if (image && !file.identity) {
            setPreview({ key, status: 'error', message: 'This image can’t be displayed.' })
            return () => controller.abort()
        }
        const request = image
            ? readDesktopCardImage(agentId, file.path, file.identity, controller.signal).then(({ blob }) => {
                if (!active) return
                const src = URL.createObjectURL(blob)
                objectUrl.current = src
                setPreview({ key, status: 'image' as const, src })
            })
            : readDesktopCardFile(agentId, file.path, controller.signal).then(({ content, truncated }) => {
                if (active) setPreview({ key, status: 'text' as const, content, truncated })
            })
        request.catch(error => {
            if (active && !controller.signal.aborted) setPreview({ key, status: 'error', message: messageOf(error, image) })
        })
        return () => {
            active = false
            controller.abort()
            if (objectUrl.current) {
                URL.revokeObjectURL(objectUrl.current)
                objectUrl.current = null
            }
        }
    }, [agentId, file.identity, file.path, image, key])

    function failImage(src: string) {
        URL.revokeObjectURL(src)
        objectUrl.current = null
        setPreview({ key, status: 'error', message: 'This image can’t be displayed.' })
    }

    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent aria-describedby={undefined} className="flex h-[80vh] flex-col gap-0 p-0 sm:max-w-4xl">
                <div className="flex shrink-0 items-center gap-2 border-b border-border py-2 pl-4 pr-12">
                    <DialogTitle className="min-w-0 flex-1 truncate text-left font-mono text-xs font-normal text-muted-foreground">{name}</DialogTitle>
                    {files.length > 1 && (
                        <>
                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                {index + 1} / {files.length}
                            </span>
                            <Button size="icon-sm" variant="ghost" onClick={() => onIndexChange((index - 1 + files.length) % files.length)} aria-label="Previous attachment">
                                <ChevronLeftIcon className="size-4" />
                            </Button>
                            <Button size="icon-sm" variant="ghost" onClick={() => onIndexChange((index + 1) % files.length)} aria-label="Next attachment">
                                <ChevronRightIcon className="size-4" />
                            </Button>
                        </>
                    )}
                </div>
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden pb-[env(safe-area-inset-bottom)] sm:pb-0">
                    {current.status === 'text' && current.truncated && (
                        <p role="status" className="shrink-0 px-3 pt-3 text-xs text-muted-foreground">Preview shows the first 256 KB.</p>
                    )}
                    <div className="min-h-0 flex-1 overflow-hidden">
                        {current.status === 'error' ? (
                            <p className="p-3 text-xs text-destructive">{current.message}</p>
                        ) : current.status === 'image' ? (
                            <div className="flex h-full items-center justify-center overflow-auto bg-muted p-3">
                                {/* eslint-disable-next-line @next/next/no-img-element -- authenticated bytes as a released object URL */}
                                <img src={current.src} alt={name} className="max-h-full max-w-full object-contain" onError={() => failImage(current.src)} />
                            </div>
                        ) : current.status === 'text' ? (
                            <FilePreview fileName={name} content={current.content} rawUrl="" loading={false} />
                        ) : (
                            <FilePreview fileName={name} content={null} rawUrl="" loading />
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
