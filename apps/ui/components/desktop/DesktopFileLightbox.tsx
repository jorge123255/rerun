'use client'

import { FilePreview } from '@/components/files/FilePreview'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { FileCardEntry } from '@rerun/contracts'
import { ChevronLeftIcon, ChevronRightIcon } from '@/lib/icons'
import { useEffect, useRef, useState } from 'react'
import { DesktopCardError, isDesktopCardAudio, isDesktopCardImage, readDesktopCardAudio, readDesktopCardFile, readDesktopCardImage } from '@/lib/desktop/file-card'

type PreviewState =
    | { key: string; status: 'loading' }
    | { key: string; status: 'text'; content: string; truncated: boolean }
    | { key: string; status: 'image'; src: string }
    | { key: string; status: 'audio'; src: string }
    | { key: string; status: 'error'; message: string }

type PreviewKind = 'text' | 'image' | 'audio'

const loading = (key: string): PreviewState => ({ key, status: 'loading' })

function messageOf(error: unknown, kind: PreviewKind): string {
    if (kind === 'text') return 'This file could not be read.'
    if (kind === 'audio') return error instanceof DesktopCardError ? error.message : 'This audio could not be played.'
    return error instanceof DesktopCardError ? error.message : 'This image is no longer available.'
}

function stopAudio(node: HTMLAudioElement | null) {
    if (!node) return
    node.pause()
    node.removeAttribute('src')
    try { node.load() } catch { /* already detached */ }
}

/**
 * The Mac version of the original attachment lightbox. It keeps the same title bar, paging and
 * preview, but has no raw URL and no download. Text uses the authenticated Files read route; an
 * image or audio file uses its authenticated media route and a released object URL. Audio starts
 * only from the player controls and is stopped and released when the page, owner or dialog changes.
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
    const audio = isDesktopCardAudio(file.path)
    const image = !audio && isDesktopCardImage(file.path)
    const kind: PreviewKind = audio ? 'audio' : image ? 'image' : 'text'
    const key = `${agentId}\u0000${file.path}\u0000${file.identity ?? ''}\u0000${kind}`
    const [preview, setPreview] = useState<PreviewState>(() => loading(key))
    const current = preview.key === key ? preview : loading(key)
    const objectUrl = useRef<string | null>(null)
    const audioRef = useRef<HTMLAudioElement | null>(null)

    useEffect(() => {
        const controller = new AbortController()
        let active = true
        setPreview(loading(key))
        if (kind !== 'text' && !file.identity) {
            setPreview({ key, status: 'error', message: kind === 'audio' ? 'This audio can’t be played.' : 'This image can’t be displayed.' })
            return () => controller.abort()
        }
        const request = audio
            ? readDesktopCardAudio(agentId, file.path, file.identity, controller.signal).then(({ blob }) => {
                if (!active) return
                const src = URL.createObjectURL(blob)
                objectUrl.current = src
                setPreview({ key, status: 'audio' as const, src })
            })
            : image
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
            if (active && !controller.signal.aborted) setPreview({ key, status: 'error', message: messageOf(error, kind) })
        })
        return () => {
            active = false
            controller.abort()
            stopAudio(audioRef.current)
            if (objectUrl.current) {
                URL.revokeObjectURL(objectUrl.current)
                objectUrl.current = null
            }
        }
    }, [agentId, audio, file.identity, file.path, image, key, kind])

    function failImage(src: string) {
        URL.revokeObjectURL(src)
        objectUrl.current = null
        setPreview({ key, status: 'error', message: 'This image can’t be displayed.' })
    }

    function failAudio(src: string) {
        stopAudio(audioRef.current)
        URL.revokeObjectURL(src)
        objectUrl.current = null
        setPreview({ key, status: 'error', message: 'This audio can’t be played.' })
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
                        ) : current.status === 'audio' ? (
                            <div className="flex h-full items-center justify-center p-4">
                                <audio ref={audioRef} controls src={current.src} data-testid="card-audio-preview" className="w-full max-w-md"
                                    onError={() => failAudio(current.src)} />
                            </div>
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
