'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DESKTOP_DOCUMENT_IMAGE_MAX_BYTES, DESKTOP_DOCUMENT_INPUT_MAX_BYTES, type DesktopDocumentReference } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { DownloadIcon, FileIcon } from '@/lib/icons'
import { fetchDesktopDocument, readDocumentResponse } from '@/lib/desktop/document-attachments/client'
import { saveDesktopResultFile } from '@/lib/desktop/result-file-save'
import { DesktopFilePdfPreview } from '../DesktopFilePdfPreview'

const keyOf = (a: DesktopDocumentReference) => JSON.stringify([a.scope, a.attachmentId, a.sha256])

async function readOriginalDocument(response: Response, attachment: DesktopDocumentReference, cap: number, signal: AbortSignal) {
    const bytes = await readDocumentResponse(response, cap, signal)
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
        .map(value => value.toString(16).padStart(2, '0')).join('')
    signal.throwIfAborted()
    if (bytes.byteLength !== attachment.byteLength || hash !== attachment.sha256) throw new Error('This attachment changed.')
    return bytes
}

export function DesktopDocumentDownload({ attachment }: { attachment: DesktopDocumentReference }) {
    return <OwnedDownload key={keyOf(attachment)} attachment={attachment} />
}
function OwnedDownload({ attachment }: { attachment: DesktopDocumentReference }) {
    const [status, setStatus] = useState(''), pending = useRef<AbortController | null>(null)
    useEffect(() => () => pending.current?.abort(), [])
    async function download() {
        if (pending.current) return
        const controller = new AbortController(); pending.current = controller; setStatus('Saving…')
        try {
            const response = await fetchDesktopDocument(attachment, controller.signal, 'download')
            const bytes = await readOriginalDocument(response, attachment, attachment.byteLength, controller.signal)
            const saved = await saveDesktopResultFile(attachment.name, bytes)
            if (!controller.signal.aborted) setStatus(saved ? 'Saved' : '')
        } catch (error) { if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'The attachment was not saved.') }
        finally { if (pending.current === controller) pending.current = null }
    }
    return <span className="flex min-w-0 items-center gap-2"><span role="status" className="max-w-48 truncate text-xs text-muted-foreground" title={status}>{status}</span><Button disabled={status === 'Saving…'} size="icon-sm" variant="ghost" title="Download" aria-label="Download" onClick={() => void download()}><DownloadIcon className="size-4" /></Button></span>
}
export function DesktopDocumentAttachmentView({ attachment, onBack }: { attachment: DesktopDocumentReference; onBack: () => void }) {
    const key = keyOf(attachment)
    return attachment.kind === 'text'
        ? <TextDocumentPreview key={key} attachment={attachment} />
        : <OwnedDocumentView key={key} attachment={attachment} onBack={onBack} />
}

function TextDocumentPreview({ attachment }: { attachment: DesktopDocumentReference }) {
    const [result, setResult] = useState<{ text: string } | { error: string }>()
    useEffect(() => {
        const controller = new AbortController()
        void (async () => {
            try {
                const response = await fetchDesktopDocument(attachment, controller.signal, 'read')
                if (response.headers.get('content-type')?.split(';', 1)[0] !== 'text/plain') {
                    await response.body?.cancel()
                    throw new Error('This attachment has no supported preview.')
                }
                const bytes = await readOriginalDocument(response, attachment,
                    Math.min(attachment.byteLength, DESKTOP_DOCUMENT_INPUT_MAX_BYTES), controller.signal)
                const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
                setResult({ text })
            } catch (error) {
                if (!controller.signal.aborted) setResult({ error: error instanceof Error ? error.message : 'Preview is unavailable.' })
            }
        })()
        return () => controller.abort()
    }, [attachment])
    if (!result) return <p role="status" className="p-3 text-xs text-muted-foreground">Loading…</p>
    if ('error' in result) return <p role="alert" className="p-3 text-xs text-destructive">{result.error}</p>
    return <pre className="h-full overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-xs">{result.text}</pre>
}

function OwnedDocumentView({ attachment, onBack }: { attachment: DesktopDocumentReference; onBack: () => void }) {
    const sourceKey = keyOf(attachment)
    const source = useMemo(() => ({ key: sourceKey, loadPage: (page: number, scale: number, signal: AbortSignal) => fetchDesktopDocument(attachment, signal, 'preview', page, scale) }), [sourceKey])
    const [view, setView] = useState<{ src?: string; error?: string }>({})
    const media = useRef<HTMLMediaElement | null>(null)
    useEffect(() => {
        if (attachment.kind !== 'audio' && attachment.kind !== 'video' && attachment.kind !== 'image') return
        const controller = new AbortController(); let src = ''
        void (async () => {
            try {
                const response = await fetchDesktopDocument(attachment, controller.signal)
                const type = response.headers.get('content-type')?.split(';')[0] ?? ''
                const accepted = attachment.kind === 'image' ? ['image/png', 'image/jpeg', 'image/webp']
                    : attachment.kind === 'audio' ? ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac']
                        : ['video/mp4', 'video/webm', 'video/quicktime']
                if (!accepted.includes(type)) { await response.body?.cancel(); throw new Error('This attachment has no supported preview.') }
                const rendered = attachment.kind === 'image' && type === 'image/png' && type !== attachment.mimeType
                const bytes = await readDocumentResponse(response, rendered ? DESKTOP_DOCUMENT_IMAGE_MAX_BYTES : attachment.byteLength, controller.signal)
                if (!rendered && bytes.byteLength !== attachment.byteLength) throw new Error('This attachment changed.')
                controller.signal.throwIfAborted()
                src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type })); setView({ src })
            } catch (error) { if (!controller.signal.aborted) setView({ error: error instanceof Error ? error.message : 'Preview is unavailable.' }) }
        })()
        return () => { controller.abort(); if (media.current) { media.current.pause(); media.current.removeAttribute('src'); media.current.load() } if (src) URL.revokeObjectURL(src) }
    }, [sourceKey])
    if (attachment.kind === 'pdf') return <DesktopFilePdfPreview name={attachment.name} path={attachment.attachmentId} identity={attachment.sha256} srcUrl="" source={source} onBack={onBack} chrome="body" />
    if (attachment.kind === 'audio' || attachment.kind === 'video' || attachment.kind === 'image') return <div className="flex h-full items-center justify-center overflow-auto bg-muted p-3">
        {view.error ? <p role="alert" className="text-xs text-destructive">{view.error}</p> : !view.src ? <p role="status" className="text-xs text-muted-foreground">Loading…</p> : attachment.kind === 'image' ? <img src={view.src} alt={attachment.name} className="max-h-full max-w-full object-contain" /> : attachment.kind === 'audio' ? <audio ref={node => { media.current = node }} controls src={view.src} className="w-full max-w-md" /> : <video ref={node => { media.current = node }} controls src={view.src} className="max-h-full max-w-full" />}
    </div>
    return <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"><FileIcon className="size-8" /><p className="text-xs">No preview available for this file type</p><DesktopDocumentDownload attachment={attachment} /></div>
}
