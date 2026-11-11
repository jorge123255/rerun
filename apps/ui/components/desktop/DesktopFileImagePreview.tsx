'use client'

import { PanelEditorHeader } from '@/components/ui/panel-editor'
import { Skeleton } from '@/components/ui/skeleton'
import type { SiblingFiles } from '@/components/files/useSiblingFiles'
import { useEffect, useState, type ReactNode, type Ref } from 'react'
import { FileSiblingControls } from './DesktopFileSiblingNav'

const RASTER_NAME = /^.+\.(?:png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** Matches DESKTOP_IMAGE_MAX_BYTES in the desktop image reader. */
const IMAGE_MAX_BYTES = 8 * 1024 * 1024

export function isDesktopRasterName(name: string): boolean {
    return !name.includes('/') && !name.includes('\\') && !name.includes('\0') && RASTER_NAME.test(name)
}

export type DesktopFileImagePreviewProps = {
    name: string
    /** Workspace-relative path of an existing file. Not a filesystem path or a hosted URL. */
    path: string
    identity?: string
    /** Same-origin `GET /api/desktop/agents/:agentId/files/image` URL for this path. */
    srcUrl: string
    onBack: () => void
    siblings?: SiblingFiles | null
    headerActions?: ReactNode
    viewerRef?: Ref<HTMLDivElement>
    onPreviewIdentity?: (hash: string | null) => void
}

type View = { loading: true } | { error: string } | { src: string }

/** FileDetail header and FilePreview image frame, filled from the authenticated desktop route.
 * The original preview is `<img src={rawUrl}>`. This Mac route has no hosted file URL, so the
 * same bytes are shown from a blob. GIF and animated WebP stay in that `<img>` and are not
 * drawn to a canvas or played as audio or video. */
export function DesktopFileImagePreview({ name, path, identity, srcUrl, onBack, siblings = null, viewerRef, headerActions, onPreviewIdentity }: DesktopFileImagePreviewProps) {
    const [view, setView] = useState<View>({ loading: true })
    const requestKey = `${path}\0${identity ?? ''}\0${srcUrl}`
    const [requestKeySeen, setRequestKeySeen] = useState(requestKey)
    if (requestKeySeen !== requestKey) {
        setRequestKeySeen(requestKey)
        setView({ loading: true })
    }

    useEffect(() => {
        onPreviewIdentity?.(null)
        if (!isDesktopImageRoute(srcUrl, path, identity)) {
            setView({ error: 'Could not preview this image.' })
            return
        }
        const controller = new AbortController()
        let objectUrl = ''
        let cancelled = false
        setView({ loading: true })
        void (async () => {
            try {
                const response = await fetch(previewUrl(srcUrl), { cache: 'no-store', signal: controller.signal })
                const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
                if (!response.ok || !RASTER_TYPES.has(type)) {
                    const body = await response.json().catch(() => null) as { error?: unknown } | null
                    if (!cancelled) setView({ error: typeof body?.error === 'string' ? body.error : response.ok ? 'This file is not a supported image.' : 'Could not preview this image.' })
                    return
                }
                const bytes = await response.arrayBuffer()
                if (cancelled) return
                if (bytes.byteLength < 1 || bytes.byteLength > IMAGE_MAX_BYTES) {
                    setView({ error: bytes.byteLength > IMAGE_MAX_BYTES ? 'Images can be up to 8 MB.' : 'This image is damaged and can’t be previewed.' })
                    return
                }
                objectUrl = URL.createObjectURL(new Blob([bytes], { type }))
                if (cancelled) { URL.revokeObjectURL(objectUrl); return }
                onPreviewIdentity?.(response.headers.get('x-rerun-shared-sha256'))
                setView({ src: objectUrl })
            } catch {
                if (!cancelled) setView({ error: 'Could not preview this image.' })
            }
        })()
        return () => {
            cancelled = true
            controller.abort()
            if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
    }, [identity, path, srcUrl, onPreviewIdentity])

    return <div ref={viewerRef} className="flex min-h-0 flex-1 flex-col">
        <PanelEditorHeader title={name} onBack={onBack} mono>
            <FileSiblingControls siblings={siblings} />{headerActions}
        </PanelEditorHeader>
        <div key={path} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {'src' in view ? <div className="flex h-full items-center justify-center overflow-auto bg-muted p-3">
                <img src={view.src} alt={name} data-testid="file-image-preview" className="max-h-full max-w-full object-contain"
                    onError={() => setView(current => {
                        if ('src' in current) URL.revokeObjectURL(current.src)
                        return { error: 'This image is damaged and can’t be previewed.' }
                    })} />
            </div> : 'error' in view ? <p role="alert" className="p-3 text-xs text-destructive">{view.error}</p>
                : <ImagePreviewSkeleton />}
        </div>
    </div>
}

function previewUrl(srcUrl: string): string {
    const url = new URL(srcUrl, 'http://127.0.0.1')
    url.searchParams.set('animation', '1')
    return `${url.pathname}${url.search}`
}

function isDesktopImageRoute(srcUrl: string, path: string, identity?: string): boolean {
    if (!srcUrl.startsWith('/api/desktop/') || srcUrl.includes('://') || srcUrl.includes('\\')) return false
    try {
        const url = new URL(srcUrl, 'http://127.0.0.1')
        return (/^\/api\/desktop\/agents\/[^/]+\/files\/image$/.test(url.pathname) || url.pathname === '/api/desktop/shared-files/media')
            && url.searchParams.get('path') === path
            && (url.searchParams.get('identity') ?? undefined) === identity
    } catch { return false }
}

const BODY_WIDTHS = ['w-4/5', 'w-full', 'w-3/5', 'w-11/12', 'w-2/3', 'w-3/4', 'w-1/2']

function ImagePreviewSkeleton() {
    return <div role="status" aria-label="Loading preview" data-testid="file-image-loading" className="h-full space-y-1.5 p-3">
        {BODY_WIDTHS.map((width, index) => <Skeleton key={index} className={`h-3 ${width}`} />)}
    </div>
}
