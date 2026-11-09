'use client'

import { PanelEditorHeader } from '@/components/ui/panel-editor'
import { Skeleton } from '@/components/ui/skeleton'
import type { SiblingFiles } from '@/components/files/useSiblingFiles'
import { useCallback, useEffect, useRef, useState, type Ref } from 'react'
import { FileSiblingControls } from './DesktopFileSiblingNav'

const AUDIO_TYPES = new Set(['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac'])
const AUDIO_NAME = /^.+\.(?:wav|mp3|m4a|ogg|flac)$/i
/** Matches DESKTOP_AUDIO_MAX_BYTES in the desktop audio reader. */
const AUDIO_MAX_BYTES = 16 * 1024 * 1024

export function isDesktopAudioName(name: string): boolean {
    return !name.includes('/') && !name.includes('\\') && !name.includes('\0') && AUDIO_NAME.test(name)
}

export type DesktopFileAudioPreviewProps = {
    name: string
    /** Workspace-relative path of an existing file. Not a filesystem path or a hosted URL. */
    path: string
    identity?: string
    /** Same-origin `GET /api/desktop/agents/:agentId/files/audio` URL for this path. */
    srcUrl: string
    onBack: () => void
    siblings?: SiblingFiles | null
    viewerRef?: Ref<HTMLDivElement>
}

type View = { loading: true } | { error: string } | { src: string }

/** FileDetail header and FilePreview audio controls, filled from the authenticated desktop route. */
export function DesktopFileAudioPreview({ name, path, identity, srcUrl, onBack, siblings = null, viewerRef }: DesktopFileAudioPreviewProps) {
    const audioRef = useRef<HTMLAudioElement | null>(null)
    const failed = useRef(false)
    const [view, setView] = useState<View>({ loading: true })
    const requestKey = `${path}\0${identity ?? ''}\0${srcUrl}`
    const [requestKeySeen, setRequestKeySeen] = useState(requestKey)
    if (requestKeySeen !== requestKey) {
        setRequestKeySeen(requestKey)
        setView({ loading: true })
    }
    const bindAudio = useCallback((node: HTMLAudioElement | null) => {
        if (audioRef.current && audioRef.current !== node) stopAudio(audioRef.current)
        audioRef.current = node
    }, [])

    useEffect(() => {
        if (!isDesktopAudioRoute(srcUrl, path, identity)) {
            setView({ error: 'Could not read this audio.' })
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
                if (!response.ok || !AUDIO_TYPES.has(type)) {
                    const body = await response.json().catch(() => null) as { error?: unknown } | null
                    if (!cancelled) setView({ error: typeof body?.error === 'string' ? body.error : response.ok ? 'This file is not a supported audio file.' : 'Could not read this audio.' })
                    return
                }
                const bytes = await response.arrayBuffer()
                if (cancelled) return
                if (bytes.byteLength < 1 || bytes.byteLength > AUDIO_MAX_BYTES) {
                    setView({ error: bytes.byteLength > AUDIO_MAX_BYTES ? 'Audio files can be up to 16 MB.' : 'This audio is damaged and can’t be previewed.' })
                    return
                }
                objectUrl = URL.createObjectURL(new Blob([bytes], { type }))
                if (cancelled) { URL.revokeObjectURL(objectUrl); return }
                setView({ src: objectUrl })
            } catch {
                if (!cancelled) setView({ error: 'Could not read this audio.' })
            }
        })()
        return () => {
            cancelled = true
            controller.abort()
            stopAudio(audioRef.current)
            if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
    }, [identity, path, srcUrl])

    return <div ref={viewerRef} className="flex min-h-0 flex-1 flex-col">
        <PanelEditorHeader title={name} onBack={onBack} mono>
            <FileSiblingControls siblings={siblings} />
        </PanelEditorHeader>
        <div key={path} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {'src' in view ? <div className="flex h-full items-center justify-center p-4">
                <audio ref={bindAudio} controls src={view.src} data-testid="file-audio-preview" className="w-full max-w-md"
                    onError={() => {
                        if (failed.current || !audioRef.current?.getAttribute('src')) return
                        failed.current = true
                        stopAudio(audioRef.current)
                        setView(current => {
                            if ('src' in current) URL.revokeObjectURL(current.src)
                            return { error: 'This audio can’t be played.' }
                        })
                    }} />
            </div> : 'error' in view ? <p role="alert" className="p-3 text-xs text-destructive">{view.error}</p>
                : <AudioPreviewSkeleton />}
        </div>
    </div>
}

function stopAudio(node: HTMLAudioElement | null) {
    if (!node) return
    node.pause()
    node.removeAttribute('src')
    try { node.load() } catch { /* already detached */ }
}

function isDesktopAudioRoute(srcUrl: string, path: string, identity?: string): boolean {
    if (!srcUrl.startsWith('/api/desktop/agents/') || srcUrl.includes('://') || srcUrl.includes('\\')) return false
    try {
        const url = new URL(srcUrl, 'http://127.0.0.1')
        return (/^\/api\/desktop\/agents\/[^/]+\/files\/audio$/.test(url.pathname) || url.pathname === '/api/desktop/shared-files/media')
            && url.searchParams.get('path') === path
            && (url.searchParams.get('identity') ?? undefined) === identity
    } catch { return false }
}

const BODY_WIDTHS = ['w-4/5', 'w-full', 'w-3/5', 'w-11/12', 'w-2/3', 'w-3/4', 'w-1/2']

function AudioPreviewSkeleton() {
    return <div role="status" aria-label="Loading preview" data-testid="file-audio-loading" className="h-full space-y-1.5 p-3">
        {BODY_WIDTHS.map((width, index) => <Skeleton key={index} className={`h-3 ${width}`} />)}
    </div>
}
