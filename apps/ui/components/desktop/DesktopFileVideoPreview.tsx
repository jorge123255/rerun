'use client'

import { PanelEditorHeader } from '@/components/ui/panel-editor'
import { Skeleton } from '@/components/ui/skeleton'
import { useCallback, useEffect, useRef, useState } from 'react'

const VIDEO_NAME = /^.+\.mp4$/i
const VIDEO_TYPES = new Set(['video/mp4'])
/** Matches DESKTOP_VIDEO_MAX_BYTES in the desktop video reader. */
const VIDEO_MAX_BYTES = 16 * 1024 * 1024

export function isDesktopVideoName(name: string): boolean {
    return !name.includes('/') && !name.includes('\\') && !name.includes('\0') && VIDEO_NAME.test(name)
}

export type DesktopFileVideoPreviewProps = {
    name: string
    /** Workspace-relative path of an existing file. Not a filesystem path or a hosted URL. */
    path: string
    identity?: string
    /** Same-origin `GET /api/desktop/agents/:agentId/files/video` URL for this path. */
    srcUrl: string
    onBack: () => void
}

type View = { loading: true } | { error: string } | { src: string }

/** FileDetail header and FilePreview video controls, filled from the authenticated desktop route. */
export function DesktopFileVideoPreview({ name, path, identity, srcUrl, onBack }: DesktopFileVideoPreviewProps) {
    const videoRef = useRef<HTMLVideoElement | null>(null)
    const failed = useRef(false)
    const [view, setView] = useState<View>({ loading: true })
    const bindVideo = useCallback((node: HTMLVideoElement | null) => {
        if (videoRef.current && videoRef.current !== node) stopVideo(videoRef.current)
        videoRef.current = node
    }, [])

    useEffect(() => {
        if (!isDesktopVideoRoute(srcUrl, path, identity)) {
            setView({ error: 'Could not read this video.' })
            return
        }
        const controller = new AbortController()
        let objectUrl = ''
        let cancelled = false
        failed.current = false
        setView({ loading: true })
        void (async () => {
            try {
                const response = await fetch(srcUrl, { cache: 'no-store', signal: controller.signal })
                const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
                if (!response.ok || !VIDEO_TYPES.has(type)) {
                    const body = await response.json().catch(() => null) as { error?: unknown } | null
                    if (!cancelled) setView({ error: typeof body?.error === 'string' ? body.error : response.ok ? 'This file is not a supported video file.' : 'Could not read this video.' })
                    return
                }
                const bytes = await response.arrayBuffer()
                if (cancelled) return
                if (bytes.byteLength < 1 || bytes.byteLength > VIDEO_MAX_BYTES) {
                    setView({ error: bytes.byteLength > VIDEO_MAX_BYTES ? 'Video files can be up to 16 MB.' : 'This video is damaged and can’t be previewed.' })
                    return
                }
                objectUrl = URL.createObjectURL(new Blob([bytes], { type }))
                if (cancelled) { URL.revokeObjectURL(objectUrl); return }
                setView({ src: objectUrl })
            } catch {
                if (!cancelled) setView({ error: 'Could not read this video.' })
            }
        })()
        return () => {
            cancelled = true
            controller.abort()
            stopVideo(videoRef.current)
            if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
    }, [identity, path, srcUrl])

    return <div className="flex min-h-0 flex-1 flex-col">
        <PanelEditorHeader title={name} onBack={onBack} mono />
        <div key={path} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {'src' in view ? <div className="flex h-full items-center justify-center overflow-auto bg-muted p-3">
                <video ref={bindVideo} controls src={view.src} data-testid="file-video-preview" className="max-h-full max-w-full"
                    onError={() => {
                        if (failed.current || !videoRef.current?.getAttribute('src')) return
                        failed.current = true
                        stopVideo(videoRef.current)
                        setView(current => {
                            if ('src' in current) URL.revokeObjectURL(current.src)
                            return { error: 'This video can’t be played.' }
                        })
                    }} />
            </div> : 'error' in view ? <p role="alert" className="p-3 text-xs text-destructive">{view.error}</p>
                : <VideoPreviewSkeleton />}
        </div>
    </div>
}

function stopVideo(node: HTMLVideoElement | null) {
    if (!node) return
    node.pause()
    node.removeAttribute('src')
    try { node.load() } catch { /* already detached */ }
}

function isDesktopVideoRoute(srcUrl: string, path: string, identity?: string): boolean {
    if (!srcUrl.startsWith('/api/desktop/agents/') || srcUrl.includes('://') || srcUrl.includes('\\')) return false
    try {
        const url = new URL(srcUrl, 'http://127.0.0.1')
        return /^\/api\/desktop\/agents\/[^/]+\/files\/video$/.test(url.pathname)
            && url.searchParams.get('path') === path
            && (url.searchParams.get('identity') ?? undefined) === identity
    } catch { return false }
}

const BODY_WIDTHS = ['w-4/5', 'w-full', 'w-3/5', 'w-11/12', 'w-2/3', 'w-3/4', 'w-1/2']

function VideoPreviewSkeleton() {
    return <div role="status" aria-label="Loading preview" data-testid="file-video-loading" className="h-full space-y-1.5 p-3">
        {BODY_WIDTHS.map((width, index) => <Skeleton key={index} className={`h-3 ${width}`} />)}
    </div>
}
