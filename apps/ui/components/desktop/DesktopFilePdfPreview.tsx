'use client'

import type { SiblingFiles } from '@/components/files/useSiblingFiles'
import { Button } from '@/components/ui/button'
import { PanelEditorHeader } from '@/components/ui/panel-editor'
import { Skeleton } from '@/components/ui/skeleton'
import { desktopPdfFindMessage, desktopPdfSamePointSize, desktopPdfTextOf, desktopPdfTextSearchable, findDesktopPdfText, DESKTOP_PDF_TEXT_MAX_RESPONSE, type DesktopPdfTextDocument, type DesktopPdfTextMatch } from '@/lib/desktop/pdf-text'
import { ChevronLeftIcon, ChevronRightIcon, MinusIcon, PlusIcon } from '@/lib/icons'
import { useEffect, useRef, useState, type Ref } from 'react'
import { DesktopFilePdfFind } from './DesktopFilePdfFind'
import { DesktopFilePdfTextLayer } from './DesktopFilePdfTextLayer'
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
    /** `files` keeps the Files header and sibling arrows. `body` is the page frame for a lightbox that already has a title. */
    chrome?: 'files' | 'body'
}
type PageMeta = { page: number; pages: number; width: number; height: number; pageWidth: number | null; pageHeight: number | null; sha256: string | null }
type View = { key: string; loading: true } | { key: string; error: string } | { key: string; src: string; meta: PageMeta; release: () => void }
type TextState = { key: string; status: 'idle' | 'loading' } | { key: string; status: 'error'; message: string } | { key: string; status: 'ready'; document: DesktopPdfTextDocument }

export function DesktopFilePdfPreview(props: Props) {
    // Changing coworker, file, or listing identity discards both page selection and zoom.
    return <PdfDocument key={`${props.srcUrl}\0${props.path}\0${props.identity ?? ''}`} {...props} />
}

/** Rerun's FileDetail header and white PDF frame. The page is a PNG; selection and Find sit on top of it. */
function PdfDocument({ name, path, identity, srcUrl, onBack, siblings = null, viewerRef, chrome = 'files' }: Props) {
    const [page, setPage] = useState(1)
    const [scale, setScale] = useState(1)
    const [pages, setPages] = useState<number | null>(null)
    const [attempt, setAttempt] = useState(0)
    const requestKey = `${page}\0${scale}\0${attempt}`
    const currentKey = useRef(requestKey)
    currentKey.current = requestKey
    const [view, setView] = useState<View>({ key: requestKey, loading: true })
    const visible: View = view.key === requestKey ? view : { key: requestKey, loading: true }
    const [documentHash, setDocumentHash] = useState<string | null>(null)
    const textKey = `${srcUrl}\0${path}\0${identity ?? ''}\0${documentHash ?? ''}`
    const [text, setText] = useState<TextState>({ key: textKey, status: 'idle' })
    const textRef = useRef(text)
    const [query, setQuery] = useState('')
    const [activeMatch, setActiveMatch] = useState(0)
    const [found, setFound] = useState<{ query: string; matches: DesktopPdfTextMatch[]; limited: boolean }>({ query: '', matches: [], limited: false })
    const findGeneration = useRef(0)
    const canReadText = 'src' in visible && visible.meta.pageWidth !== null && visible.meta.pageHeight !== null && visible.meta.sha256 !== null

    useEffect(() => { textRef.current = text }, [text])

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
                setDocumentHash(meta.sha256)
                setView({ key: requestKey, src: objectUrl, meta, release })
            } catch (error) {
                if (!cancelled) setView({ key: requestKey, error: error instanceof Error ? error.message : 'Could not preview this PDF page.' })
            }
        })()
        return () => { cancelled = true; controller.abort(); release() }
    }, [srcUrl, path, identity, page, scale, requestKey])

    // Text is tied to the exact bytes rendered, not only dev:ino (which survives in-place edits).
    // Page and zoom reuse it while that content hash is unchanged.
    useEffect(() => {
        if (!canReadText || !documentHash) return
        const current = textRef.current
        if (current.key === textKey && (current.status === 'ready' || current.status === 'error')) return
        const url = pdfTextRoute(srcUrl, path, identity)
        if (!url) { setText({ key: textKey, status: 'error', message: 'Could not read this PDF.' }); return }
        url.searchParams.set('sha256', documentHash)
        const controller = new AbortController()
        let cancelled = false
        setText({ key: textKey, status: 'loading' })
        void (async () => {
            try {
                const response = await fetch(`${url.pathname}?${url.searchParams}`, {
                    cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: controller.signal,
                })
                if (cancelled) { await response.body?.cancel(); return }
                const document = await readPdfText(response, path, identity, documentHash, controller.signal)
                if (cancelled) return
                setText({ key: textKey, status: 'ready', document })
            } catch (error) {
                if (cancelled) return
                const message = error instanceof Error && error.name !== 'AbortError' ? error.message : 'Could not read this PDF’s text.'
                setText({ key: textKey, status: 'error', message })
            }
        })()
        return () => { cancelled = true; controller.abort() }
    }, [canReadText, textKey, srcUrl, path, identity, documentHash])

    useEffect(() => {
        const generation = ++findGeneration.current
        let cancelled = false
        const document = text.key === textKey && text.status === 'ready' ? text.document : null
        void (async () => {
            await Promise.resolve()
            if (cancelled || generation !== findGeneration.current) return
            const result = document ? findDesktopPdfText(document.pages, query) : { matches: [], limited: false }
            setFound({ query, matches: result.matches, limited: result.limited })
            setActiveMatch(0)
            if (result.matches[0]) setPage(result.matches[0].page)
        })()
        return () => { cancelled = true }
    }, [query, text, textKey])

    const document = text.key === textKey && text.status === 'ready' ? text.document : null
    const pageText = document?.pages.find(item => item.page === page) ?? null
    const rasterWidth = 'src' in visible ? visible.meta.pageWidth : null
    const rasterHeight = 'src' in visible ? visible.meta.pageHeight : null
    const aligned = !!pageText && rasterWidth !== null && rasterHeight !== null && desktopPdfSamePointSize(pageText.pageWidth, rasterWidth) && desktopPdfSamePointSize(pageText.pageHeight, rasterHeight)
    const settled = found.query === query ? found : { query, matches: [] as DesktopPdfTextMatch[], limited: false }
    const matchIndex = settled.matches.length === 0 ? 0 : activeMatch % settled.matches.length
    const copy = desktopPdfFindMessage({
        phase: !canReadText ? 'hidden' : text.status === 'ready' ? 'ready' : text.status === 'error' ? 'error' : 'loading',
        error: text.status === 'error' ? text.message : '',
        searchable: document ? desktopPdfTextSearchable(document.pages) : false,
        truncated: document?.truncated ?? false,
        aligned, pagePresent: !!pageText, query, matchCount: settled.matches.length, matchIndex, limited: settled.limited,
    })
    const marks = pageText && aligned ? settled.matches.flatMap((match, index) => match.page === pageText.page ? [{ start: match.start, end: match.end, active: index === matchIndex }] : []) : []
    const step = (delta: number) => {
        if (settled.matches.length === 0) return
        const index = (matchIndex + delta + settled.matches.length) % settled.matches.length
        setActiveMatch(index)
        const match = settled.matches[index]
        if (match && match.page !== page) setPage(match.page)
    }

    return <div ref={viewerRef} className="flex min-h-0 flex-1 flex-col">
        {chrome === 'files' && <PanelEditorHeader title={name} onBack={onBack} mono><FileSiblingControls siblings={siblings} /></PanelEditorHeader>}
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
        {canReadText && <DesktopFilePdfFind query={query} onQuery={setQuery} count={copy.count} message={copy.message} canStep={settled.matches.length > 0} onPrevious={() => step(-1)} onNext={() => step(1)} />}
        <div className="min-h-0 flex-1 overflow-auto bg-muted p-3" data-testid="file-pdf-frame">
            {'src' in visible ? <div className="relative bg-white shadow-sm" style={{ width: `${scale * 100}%`, marginInline: scale <= 1 ? 'auto' : 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- bounded generated PNG object URLs are not Next Image sources */}
                <img src={visible.src} alt={`${name}, page ${page} of ${visible.meta.pages}`} width={visible.meta.width} height={visible.meta.height} draggable={false}
                    data-testid="file-pdf-preview" className="block h-auto w-full select-none bg-white" onError={() => {
                        if (currentKey.current !== visible.key) return
                        visible.release()
                        setView(current => 'src' in current && current.src === visible.src ? { key: visible.key, error: 'This PDF page could not be displayed.' } : current)
                    }} />
                {aligned && pageText && pageText.runs.length > 0 && <DesktopFilePdfTextLayer text={pageText.text} rotation={pageText.rotation} pageWidth={pageText.pageWidth} pageHeight={pageText.pageHeight} crop={pageText.crop} runs={pageText.runs} marks={marks} />}
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

function pdfTextRoute(srcUrl: string, path: string, identity?: string): URL | null {
    const url = pdfRoute(srcUrl, path, identity)
    if (!url) return null
    url.pathname = url.pathname.replace(/\/pdf$/, '/pdf-text')
    return url.pathname.endsWith('/files/pdf-text') ? url : null
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
    const pageWidth = pointSize(headers.get('x-pdf-page-width'))
    const pageHeight = pointSize(headers.get('x-pdf-page-height'))
    if ((pageWidth === null) !== (pageHeight === null)) throw new Error('This PDF page returned invalid preview information.')
    const sha256 = headers.get('x-pdf-sha256')
    if (sha256 !== null && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('This PDF page returned invalid preview information.')
    return { page, pages, width, height, pageWidth, pageHeight, sha256 }
}

function pointSize(value: string | null): number | null {
    if (value === null) return null
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error('This PDF page returned invalid preview information.')
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0 || number > 14_400) throw new Error('This PDF page returned invalid preview information.')
    return number
}

async function readPdfText(response: Response, path: string, identity: string | undefined, expectedHash: string, signal: AbortSignal): Promise<DesktopPdfTextDocument> {
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (!response.ok) {
        let message = 'Could not read this PDF’s text.'
        try {
            const body = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 16_384, signal))) as { error?: unknown }
            if (typeof body.error === 'string' && body.error.length > 0 && body.error.length <= 500 && !body.error.includes('\0')) message = body.error
        } catch { /* A non-JSON or oversized error is not document content. */ }
        throw new Error(message)
    }
    if (type !== 'application/json') { await response.body?.cancel(); throw new Error('Could not read this PDF’s text.') }
    if (response.headers.get('x-pdf-sha256') !== expectedHash) { await response.body?.cancel(); throw new Error('This PDF changed. Reopen it to search the current document.') }
    const bytes = await boundedBytes(response, DESKTOP_PDF_TEXT_MAX_RESPONSE, signal, 'PDF text is too large to search.')
    if (bytes.indexOf(0) !== -1) throw new Error('Could not read this PDF’s text.')
    let body: unknown
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new Error('Could not read this PDF’s text.') }
    const document = desktopPdfTextOf(body, identity, path)
    if (!document) throw new Error('Send this PDF to preview again.')
    return document
}

async function boundedBytes(response: Response, max: number, signal: AbortSignal, tooLarge = 'This PDF page is too large to preview.'): Promise<Uint8Array<ArrayBuffer>> {
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) {
        await response.body?.cancel(); throw new Error(tooLarge)
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
            if (length > max) throw new Error(tooLarge)
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
