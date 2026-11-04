'use client'

import { PanelEditorHeader } from '@/components/ui/panel-editor'
import { Skeleton } from '@/components/ui/skeleton'
import type { SiblingFiles } from '@/components/files/useSiblingFiles'
import { useCallback, useEffect, useRef, useState, type Ref } from 'react'
import { FileSiblingControls } from './DesktopFileSiblingNav'

const PDF_NAME = /^.+\.pdf$/i
const PDF_TYPES = new Set(['application/pdf'])
/** Matches DESKTOP_PDF_MAX_BYTES in the desktop PDF reader. */
const PDF_MAX_BYTES = 16 * 1024 * 1024
/** Document policy for the preview iframe. A blob URL does not inherit the route response CSP. */
export const DESKTOP_PDF_FRAME_CSP = "default-src 'none'; sandbox"

export function isDesktopPdfName(name: string): boolean {
    return !name.includes('/') && !name.includes('\\') && !name.includes('\0') && PDF_NAME.test(name)
}

export type DesktopFilePdfPreviewProps = {
    name: string
    /** Workspace-relative path of an existing file. Not a filesystem path or a hosted URL. */
    path: string
    identity?: string
    /** Same-origin `GET /api/desktop/agents/:agentId/files/pdf` URL for this path. */
    srcUrl: string
    onBack: () => void
    siblings?: SiblingFiles | null
    viewerRef?: Ref<HTMLDivElement>
}

type View = { loading: true } | { error: string } | { src: string }

/** FileDetail header and the original FilePreview PDF iframe, filled from the authenticated desktop route.
 * The iframe src is a blob URL of the route bytes. The original component iframes `rawUrl` directly.
 * The empty sandbox and DESKTOP_PDF_FRAME_CSP are the embedded document boundary. A fetch response
 * and an iframe load event are not treated as proof that the viewer displayed the file. */
export function DesktopFilePdfPreview({ name, path, identity, srcUrl, onBack, siblings = null, viewerRef }: DesktopFilePdfPreviewProps) {
    const frameRef = useRef<HTMLIFrameElement | null>(null)
    const failed = useRef(false)
    const [view, setView] = useState<View>({ loading: true })
    const requestKey = `${path}\0${identity ?? ''}\0${srcUrl}`
    const [requestKeySeen, setRequestKeySeen] = useState(requestKey)
    if (requestKeySeen !== requestKey) {
        setRequestKeySeen(requestKey)
        setView({ loading: true })
    }
    const frameSrc = 'src' in view ? view.src : ''
    const bindFrame = useCallback((node: HTMLIFrameElement | null) => {
        if (frameRef.current && frameRef.current !== node) stopFrame(frameRef.current)
        frameRef.current = node
        if (!node) return
        // The blob navigation starts when src is set. csp has to be present first; a blob URL
        // does not inherit the route response header.
        node.setAttribute('csp', DESKTOP_PDF_FRAME_CSP)
        if (node.getAttribute('sandbox') !== '') node.setAttribute('sandbox', '')
        if (frameSrc && node.getAttribute('src') !== frameSrc) node.setAttribute('src', frameSrc)
    }, [frameSrc])

    useEffect(() => {
        if (!isDesktopPdfRoute(srcUrl, path, identity)) {
            setView({ error: 'Could not read this PDF.' })
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
                if (!response.ok || !PDF_TYPES.has(type)) {
                    const body = await response.json().catch(() => null) as { error?: unknown } | null
                    if (!cancelled) setView({ error: typeof body?.error === 'string' ? body.error : response.ok ? 'This file is not a supported PDF.' : 'Could not read this PDF.' })
                    return
                }
                const bytes = await response.arrayBuffer()
                if (cancelled) return
                if (bytes.byteLength < 1 || bytes.byteLength > PDF_MAX_BYTES) {
                    setView({ error: bytes.byteLength > PDF_MAX_BYTES ? 'PDF files can be up to 16 MB.' : 'This PDF is damaged and can’t be previewed.' })
                    return
                }
                objectUrl = URL.createObjectURL(new Blob([bytes], { type }))
                if (cancelled) { URL.revokeObjectURL(objectUrl); return }
                setView({ src: objectUrl })
            } catch {
                if (!cancelled) setView({ error: 'Could not read this PDF.' })
            }
        })()
        return () => {
            cancelled = true
            controller.abort()
            stopFrame(frameRef.current)
            if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
    }, [identity, path, srcUrl])

    return <div ref={viewerRef} className="flex min-h-0 flex-1 flex-col">
        <PanelEditorHeader title={name} onBack={onBack} mono>
            <FileSiblingControls siblings={siblings} />
        </PanelEditorHeader>
        <div key={path} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {'src' in view ? <iframe ref={bindFrame} title={name} sandbox="" data-testid="file-pdf-preview" className="h-full w-full bg-white"
                onError={() => {
                    if (failed.current || !frameRef.current?.getAttribute('src')) return
                    failed.current = true
                    stopFrame(frameRef.current)
                    setView(current => {
                        if ('src' in current) URL.revokeObjectURL(current.src)
                        return { error: 'This PDF can’t be displayed.' }
                    })
                }} /> : 'error' in view ? <p role="alert" className="p-3 text-xs text-destructive">{view.error}</p>
                : <PdfPreviewSkeleton />}
        </div>
    </div>
}

function stopFrame(node: HTMLIFrameElement | null) {
    if (!node) return
    node.removeAttribute('src')
}

function isDesktopPdfRoute(srcUrl: string, path: string, identity?: string): boolean {
    if (!srcUrl.startsWith('/api/desktop/agents/') || srcUrl.includes('://') || srcUrl.includes('\\')) return false
    try {
        const url = new URL(srcUrl, 'http://127.0.0.1')
        return /^\/api\/desktop\/agents\/[^/]+\/files\/pdf$/.test(url.pathname)
            && url.searchParams.get('path') === path
            && (url.searchParams.get('identity') ?? undefined) === identity
    } catch { return false }
}

const BODY_WIDTHS = ['w-4/5', 'w-full', 'w-3/5', 'w-11/12', 'w-2/3', 'w-3/4', 'w-1/2']

function PdfPreviewSkeleton() {
    return <div role="status" aria-label="Loading preview" data-testid="file-pdf-loading" className="h-full space-y-1.5 p-3">
        {BODY_WIDTHS.map((width, index) => <Skeleton key={index} className={`h-3 ${width}`} />)}
    </div>
}
