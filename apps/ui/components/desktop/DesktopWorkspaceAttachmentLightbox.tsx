'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { DESKTOP_ATTACHMENT_MAX_BYTES, isDesktopAttachmentPath } from '@rerun/contracts'
import { AttachmentLightboxFrame } from '@/components/chat/AttachmentLightbox'
import { FilePreview } from '@/components/files/FilePreview'
import { Button } from '@/components/ui/button'
import { readDocumentResponse } from '@/lib/desktop/document-attachments/client'
import { saveDesktopResultFile } from '@/lib/desktop/result-file-save'
import { DownloadIcon } from '@/lib/icons'

export type WorkspaceAttachmentSource = { agentId: string } | { sessionId: string; messageId: string }
type PreviewSource = { url: string | null }
type Preview = { source: PreviewSource } & ({ bytes: Uint8Array; content: string } | { error: true })

export function DesktopWorkspaceAttachmentLightbox({ source, paths, index, onIndexChange, onClose }: {
    source: WorkspaceAttachmentSource
    paths: readonly string[]
    index: number
    onIndexChange: (index: number) => void
    onClose: () => void
}) {
    const saved = 'sessionId' in source
    const endpoint = saved
        ? `/api/desktop/sessions/${encodeURIComponent(source.sessionId)}/messages/${encodeURIComponent(source.messageId)}/attachment`
        : `/api/desktop/agents/${encodeURIComponent(source.agentId)}/files/read`
    const path = paths[index]
    const name = path?.split('/').at(-1) ?? ''
    const query = path && new URLSearchParams(saved ? { path } : { view: 'attachment', path })
    const url = path && query && isDesktopAttachmentPath(path) ? `${endpoint}?${query}` : null
    const previewSource = useMemo<PreviewSource>(() => ({ url }), [url])
    const [result, setResult] = useState<Preview | null>(null)

    useEffect(() => {
        const { url } = previewSource
        if (!url) return
        const controller = new AbortController()
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
        void (async () => {
            try {
                const response = await fetch(url, { cache: 'no-store', redirect: 'error', credentials: 'same-origin', signal })
                if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0] !== 'text/plain') {
                    await response.body?.cancel().catch(() => {})
                    throw new Error('This attachment could not be read.')
                }
                const bytes = await readDocumentResponse(response, DESKTOP_ATTACHMENT_MAX_BYTES, signal)
                const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
                signal.throwIfAborted()
                setResult({ source: previewSource, bytes, content })
            } catch {
                if (!controller.signal.aborted) setResult({ source: previewSource, error: true })
            }
        })()
        return () => controller.abort()
    }, [previewSource])

    if (!path) return null
    const current = result?.source === previewSource ? result : null
    const attachment = current && 'bytes' in current ? current : null
    return <AttachmentLightboxFrame name={name} index={index} count={paths.length} onIndexChange={onIndexChange} onClose={onClose}
        download={<WorkspaceAttachmentDownload key={url ?? path} name={name} bytes={attachment?.bytes} />}>
        {!url || current && 'error' in current
            ? <p role="alert" className="p-3 text-xs text-destructive">This attachment could not be read.</p>
            : <FilePreview fileName={name} content={attachment?.content ?? null} rawUrl="" loading={current === null} />}
    </AttachmentLightboxFrame>
}

function WorkspaceAttachmentDownload({ name, bytes }: { name: string; bytes?: Uint8Array }) {
    const [status, setStatus] = useState('')
    const pending = useRef(false)
    const mounted = useRef(true)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

    async function download() {
        if (!bytes || pending.current) return
        pending.current = true
        setStatus('Saving…')
        try {
            const filename = name.replaceAll('\\', '_').replace(/^\.+/, 'attachment.')
            const saved = await saveDesktopResultFile(filename, bytes)
            if (mounted.current) setStatus(saved ? 'Saved' : '')
        } catch {
            if (mounted.current) setStatus('Could not save this attachment. Try again.')
        } finally {
            pending.current = false
        }
    }

    return <span className="flex min-w-0 items-center gap-2">
        <span role="status" className="max-w-48 truncate text-xs text-muted-foreground" title={status}>{status}</span>
        <Button size="icon-sm" variant="ghost" title="Download" aria-label="Download" disabled={!bytes || status === 'Saving…'} onClick={() => void download()}>
            <DownloadIcon className="size-4" />
        </Button>
    </span>
}
