'use client'

import { FilePreview } from '@/components/files/FilePreview'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { FileCardEntry } from '@rerun/contracts'
import { ChevronLeftIcon, ChevronRightIcon } from '@/lib/icons'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
    DesktopCardError, desktopCardPdfSrc, isDesktopCardAudio, isDesktopCardImage, isDesktopCardPdf, isDesktopCardVideo,
    readDesktopCardAudio, readDesktopCardFile, readDesktopCardImage, readDesktopCardVideo,
} from '@/lib/desktop/file-card'
import { DesktopFilePdfPreview } from './DesktopFilePdfPreview'
import { stopDesktopCardVideo } from './DesktopCardVideoTile'

type PreviewState =
    | { key: string; status: 'loading' }
    | { key: string; status: 'text'; content: string; truncated: boolean }
    | { key: string; status: 'image'; src: string }
    | { key: string; status: 'audio'; src: string }
    | { key: string; status: 'video'; src: string }
    | { key: string; status: 'pdf' }
    | { key: string; status: 'error'; message: string }

type PreviewKind = 'text' | 'image' | 'audio' | 'video' | 'pdf'

const loading = (key: string): PreviewState => ({ key, status: 'loading' })

function messageOf(error: unknown, kind: PreviewKind): string {
    if (kind === 'text') return 'This file could not be read.'
    if (kind === 'audio') return error instanceof DesktopCardError ? error.message : 'This audio could not be played.'
    if (kind === 'video') return error instanceof DesktopCardError ? error.message : 'This video could not be played.'
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
 * image, audio or MP4 video uses its authenticated media route and a released object URL. A PDF
 * uses the Files page renderer, which fetches one PNG page and releases that blob. Audio and
 * video start only from the player controls and are stopped and released when the page, owner or
 * dialog changes, or when the component unmounts. PDF requests and blobs follow the same cleanup.
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
    const video = !audio && isDesktopCardVideo(file.path)
    const image = !audio && !video && isDesktopCardImage(file.path)
    const pdf = !audio && !video && !image && isDesktopCardPdf(file.path)
    const kind: PreviewKind = audio ? 'audio' : video ? 'video' : image ? 'image' : pdf ? 'pdf' : 'text'
    const key = `${agentId}\u0000${file.path}\u0000${file.identity ?? ''}\u0000${kind}`
    const [preview, setPreview] = useState<PreviewState>(() => loading(key))
    const current = preview.key === key ? preview : loading(key)
    const objectUrl = useRef<string | null>(null)
    const audioRef = useRef<HTMLAudioElement | null>(null)
    const videoRef = useRef<HTMLVideoElement | null>(null)
    const audioFailed = useRef(false)
    const videoFailed = useRef(false)
    const bindAudio = useCallback((node: HTMLAudioElement | null) => {
        if (audioRef.current && audioRef.current !== node) stopAudio(audioRef.current)
        audioRef.current = node
    }, [])
    const bindVideo = useCallback((node: HTMLVideoElement | null) => {
        if (videoRef.current && videoRef.current !== node) stopDesktopCardVideo(videoRef.current)
        videoRef.current = node
    }, [])

    useEffect(() => {
        const controller = new AbortController()
        let active = true
        audioFailed.current = false
        videoFailed.current = false
        setPreview(loading(key))
        if (kind === 'pdf') {
            if (!file.identity) {
                setPreview({ key, status: 'error', message: 'Send this PDF to preview again.' })
                return () => controller.abort()
            }
            setPreview({ key, status: 'pdf' })
            return () => { active = false; controller.abort() }
        }
        if (kind !== 'text' && !file.identity) {
            setPreview({
                key,
                status: 'error',
                message: kind === 'audio' ? 'This audio can’t be played.' : kind === 'video' ? 'This video can’t be played.' : 'This image can’t be displayed.',
            })
            return () => controller.abort()
        }
        const request = audio
            ? readDesktopCardAudio(agentId, file.path, file.identity, controller.signal).then(({ blob }) => {
                if (!active) return
                const src = URL.createObjectURL(blob)
                objectUrl.current = src
                setPreview({ key, status: 'audio' as const, src })
            })
            : video
                ? readDesktopCardVideo(agentId, file.path, file.identity, controller.signal).then(({ blob }) => {
                    if (!active) return
                    const src = URL.createObjectURL(blob)
                    objectUrl.current = src
                    setPreview({ key, status: 'video' as const, src })
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
            stopDesktopCardVideo(videoRef.current)
            if (objectUrl.current) {
                URL.revokeObjectURL(objectUrl.current)
                objectUrl.current = null
            }
        }
    }, [agentId, audio, file.identity, file.path, image, key, kind, pdf, video])

    function failImage(src: string) {
        URL.revokeObjectURL(src)
        objectUrl.current = null
        setPreview({ key, status: 'error', message: 'This image can’t be displayed.' })
    }

    function failAudio(src: string) {
        if (audioFailed.current) return
        audioFailed.current = true
        stopAudio(audioRef.current)
        URL.revokeObjectURL(src)
        objectUrl.current = null
        setPreview({ key, status: 'error', message: 'This audio can’t be played.' })
    }

    function failVideo(src: string) {
        if (videoFailed.current) return
        videoFailed.current = true
        stopDesktopCardVideo(videoRef.current)
        URL.revokeObjectURL(src)
        objectUrl.current = null
        setPreview({ key, status: 'error', message: 'This video can’t be played.' })
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
                                <audio ref={bindAudio} controls src={current.src} data-testid="card-audio-preview" className="w-full max-w-md"
                                    onError={() => failAudio(current.src)} />
                            </div>
                        ) : current.status === 'video' ? (
                            <div className="flex h-full items-center justify-center overflow-auto bg-muted p-3">
                                <video ref={bindVideo} controls src={current.src} data-testid="card-video-preview" className="max-h-full max-w-full"
                                    onError={() => failVideo(current.src)} />
                            </div>
                        ) : current.status === 'image' ? (
                            <div className="flex h-full items-center justify-center overflow-auto bg-muted p-3">
                                {/* eslint-disable-next-line @next/next/no-img-element -- authenticated bytes as a released object URL */}
                                <img src={current.src} alt={name} className="max-h-full max-w-full object-contain" onError={() => failImage(current.src)} />
                            </div>
                        ) : current.status === 'pdf' ? (
                            <div className="flex h-full min-h-0 flex-col">
                                <DesktopFilePdfPreview name={name} path={file.path} identity={file.identity} chrome="body"
                                    srcUrl={desktopCardPdfSrc(agentId, file.path, file.identity)} onBack={onClose} />
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
