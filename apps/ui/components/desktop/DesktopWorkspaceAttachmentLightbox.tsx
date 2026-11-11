'use client'

import { useCallback } from 'react'
import { DESKTOP_ATTACHMENT_MAX_BYTES } from '@rerun/contracts'
import { AttachmentLightbox } from '@/components/chat/AttachmentLightbox'
import { readDocumentResponse } from '@/lib/desktop/document-attachments/client'

export type WorkspaceAttachmentSource = { agentId: string } | { sessionId: string; messageId: string }

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
    const rawUrlFor = useCallback((path: string) => {
        const query = new URLSearchParams(saved ? { path } : { view: 'attachment', path })
        return `${endpoint}?${query}`
    }, [endpoint, saved])
    const readFile = useCallback(async (path: string) => {
        const signal = AbortSignal.timeout(10_000)
        const response = await fetch(rawUrlFor(path), { cache: 'no-store', redirect: 'error', credentials: 'same-origin', signal })
        if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0] !== 'text/plain') {
            await response.body?.cancel()
            throw new Error('This attachment could not be read.')
        }
        const bytes = await readDocumentResponse(response, DESKTOP_ATTACHMENT_MAX_BYTES, signal)
        return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), truncated: false }
    }, [rawUrlFor])

    return <AttachmentLightbox paths={paths} names={paths.map(path => path.split('/').pop()!)} index={index}
        rawUrlFor={rawUrlFor} readFile={readFile} onIndexChange={onIndexChange} onClose={onClose} />
}
