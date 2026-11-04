'use client'

import type { SiblingFiles } from '@/components/files/useSiblingFiles'
import { Button } from '@/components/ui/button'
import { PanelEditorHeader } from '@/components/ui/panel-editor'
import { Skeleton } from '@/components/ui/skeleton'
import { ChevronLeftIcon, ChevronRightIcon, MinusIcon, PlusIcon } from '@/lib/icons'
import { useEffect, useRef, useState, type Ref } from 'react'
import { FileSiblingControls } from './DesktopFileSiblingNav'

const PNG_MAX_BYTES = 8 * 1024 * 1024
const MAX_DIMENSION = 4096
const MAX_PIXELS = 8_000_000
const MAX_PAGES = 10_000
const MIN_SCALE = .5, MAX_SCALE = 2, SCALE_STEP = .25

export function isDesktopPdfName(name: string): boolean {
    return !/[\/\\\0]/.test(name) && /^.+\.pdf$/i.test(name)
}

type Props = {
    name: string
    path: string
    identity?: string
    /** Authenticated same-origin PDF page route, already bound to this owner/path/identity. */
    srcUrl: string
    onBack: () => void
    siblings?: SiblingFiles | null
    viewerRef?: Ref<HTMLDivElement>
}
type PageMeta = { page: number; pages: number; width: number; height: number }
type View = { key: string; loading: true } | { key: string; error: string } | { key: string; src: string; meta: PageMeta; release: () => void }

export function DesktopFilePdfPreview(props: Props) {
    // Changing coworker, file, or listing identity discards both page selection and zoom.
    return <PdfDocument key={`${props.srcUrl}\0${props.path}\0${props.identity ?? ''}`} {...props} />
}

/** Rerun's FileDetail header and white PDF frame, using raster pages rather than an embedded PDF. */
function PdfDocument({ name, path, identity, srcUrl, onBack, siblings = null, viewerRef }: Props) {
    const [page, setPage] = useState(1)
    const [scale, setScale] = useState(1)
    const [pages, setPages] = useState<number | null>(null)
    const [attempt, setAttempt] = useState(0)
    const requestKey = `${page}\0${scale}\0${attempt}`
    const currentKey = useRef(requestKey)
    currentKey.current = requestKey
    const [view, setView] = useState<View>({ key: requestKey, loading: true })
    const visible: View = view.key === requestKey ? view : { key: requestKey, loading: true }

    useEffect(() => {
        const url = pdfRoute(srcUrl, path, identity)
        if (!url) { setView({ key: requestKey, error: 'Could not read this PDF.' }); return }
        url.searchParams.set('page', String(page))
        url.searchParams.set('scale', String(scale))
        const controller = new AbortController()
        let cancelled = false
        let objectUrl = ''
        const release = () => { if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = '' } }
        setView({ key: requestKey, loading: true })
        void (async () => {
            try {
                const response = await fetch(`${url.pathname}?${url.searchParams}`, {
                    cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: controller.signal,
                })
                if (cancelled) { await response.body?.cancel(); return }
                const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
                if (!response.ok) {
                    let message = 'Could not preview this PDF page.'
                    try {
                        const body = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 16_384, controller.signal))) as { error?: unknown }
                        if (typeof body.error === 'string' && body.error.length <= 500) message = body.error
                    } catch { /* A non-JSON or oversized error is not document content. */ }
                    throw new Error(message)
                }
                if (type !== 'image/png') { await response.body?.cancel(); throw new Error('This PDF page could not be rendered.') }
                let meta: PageMeta
                try { meta = metadata(response.headers, page) }
                catch (error) { await response.body?.cancel(); throw error }
                const bytes = await boundedBytes(response, PNG_MAX_BYTES, controller.signal)
                if (cancelled) return
                validatePng(bytes, meta)
                objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
                if (cancelled) { release(); return }
                setPages(meta.pages)
                setView({ key: requestKey, src: objectUrl, meta, release })
            } catch (error) {
                if (!cancelled) setView({ key: requestKey, error: error instanceof Error ? error.message : 'Could not preview this PDF page.' })
            }
        })()
        return () => { cancelled = true; controller.abort(); release() }
    }, [srcUrl, path, identity, page, scale, requestKey])

    return <div ref={viewerRef} className="flex min-h-0 flex-1 flex-col">
        <PanelEditorHeader title={name} onBack={onBack} mono><FileSiblingControls siblings={siblings} /></PanelEditorHeader>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2 text-xs">
            <div className="flex items-center gap-1">
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}><ChevronLeftIcon className="size-3.5" /></Button>
                <span aria-live="polite" className="min-w-24 text-center tabular-nums">Page {page} of {pages ?? '…'}</span>
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Next page" disabled={pages === null || page >= pages} onClick={() => setPage(value => Math.min(pages ?? value, value + 1))}><ChevronRightIcon className="size-3.5" /></Button>
            </div>
            <div className="flex items-center gap-1">
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Zoom out" disabled={scale <= MIN_SCALE} onClick={() => setScale(value => Math.max(MIN_SCALE, value - SCALE_STEP))}><MinusIcon className="size-3.5" /></Button>
                <span aria-label="PDF zoom" className="min-w-10 text-center tabular-nums">{Math.round(scale * 100)}%</span>
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Zoom in" disabled={scale >= MAX_SCALE} onClick={() => setScale(value => Math.min(MAX_SCALE, value + SCALE_STEP))}><PlusIcon className="size-3.5" /></Button>
                <Button type="button" variant="ghost" size="xs" disabled={scale === 1} onClick={() => setScale(1)}>Fit width</Button>
            </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-muted p-3" data-testid="file-pdf-frame">
            {'src' in visible ? <div className="bg-white shadow-sm" style={{ width: `${scale * 100}%`, marginInline: scale <= 1 ? 'auto' : 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- bounded generated PNG object URLs are not Next Image sources */}
                <img src={visible.src} alt={`${name}, page ${page} of ${visible.meta.pages}`} width={visible.meta.width} height={visible.meta.height}
                    data-testid="file-pdf-preview" className="block h-auto w-full bg-white" onError={() => {
                        if (currentKey.current !== visible.key) return
                        visible.release()
                        setView(current => 'src' in current && current.src === visible.src ? { key: visible.key, error: 'This PDF page could not be displayed.' } : current)
                    }} />
            </div> : 'error' in visible ? <div className="space-y-2 p-3"><p role="alert" className="text-xs text-destructive">{visible.error}</p><Button type="button" variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>Retry</Button></div>
                : <div role="status" aria-label="Loading PDF page" className="mx-auto min-h-80 space-y-3 bg-white p-6"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" /></div>}
        </div>
    </div>
}

function pdfRoute(srcUrl: string, path: string, identity?: string): URL | null {
    if (!srcUrl.startsWith('/api/desktop/agents/') || srcUrl.includes('://') || srcUrl.includes('\\')) return null
    try {
        const url = new URL(srcUrl, 'http://127.0.0.1')
        if (!/^\/api\/desktop\/agents\/[^/]+\/files\/pdf$/.test(url.pathname)
            || url.searchParams.getAll('path').length !== 1 || url.searchParams.get('path') !== path
            || url.searchParams.getAll('identity').length > 1 || (url.searchParams.get('identity') ?? undefined) !== identity
            || [...url.searchParams.keys()].some(key => key !== 'path' && key !== 'identity')) return null
        return url
    } catch { return null }
}

function metadata(headers: Headers, requestedPage: number): PageMeta {
    const integer = (name: string, max: number) => {
        const value = headers.get(name)
        if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > max) throw new Error('This PDF page returned invalid preview information.')
        return Number(value)
    }
    const page = integer('x-pdf-page', MAX_PAGES), pages = integer('x-pdf-pages', MAX_PAGES)
    const width = integer('x-pdf-width', MAX_DIMENSION), height = integer('x-pdf-height', MAX_DIMENSION)
    if (page !== requestedPage || page > pages || width * height > MAX_PIXELS) throw new Error('This PDF page returned invalid preview information.')
    return { page, pages, width, height }
}

async function boundedBytes(response: Response, max: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) {
        await response.body?.cancel(); throw new Error('This PDF page is too large to preview.')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('This PDF page is empty.')
    const chunks: Uint8Array[] = []
    let length = 0
    const abort = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try {
        while (true) {
            signal.throwIfAborted()
            const next = await reader.read()
            signal.throwIfAborted()
            if (next.done) break
            length += next.value.byteLength
            if (length > max) throw new Error('This PDF page is too large to preview.')
            chunks.push(next.value)
        }
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        return bytes
    } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
}

function validatePng(bytes: Uint8Array, meta: PageMeta) {
    const bad = () => { throw new Error('This PDF page returned an invalid image.') }
    if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return bad()
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (data.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR'
        || data.getUint32(16) !== meta.width || data.getUint32(20) !== meta.height) return bad()
    const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
    if (!depths[bytes[25]!]?.includes(bytes[24]!) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1) return bad()
}
