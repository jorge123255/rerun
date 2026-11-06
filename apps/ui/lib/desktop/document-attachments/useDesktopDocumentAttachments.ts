'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
    DESKTOP_DOCUMENT_MAX_BYTES,
    DESKTOP_DOCUMENT_MAX_FILES,
    DESKTOP_DOCUMENT_TOTAL_MAX_BYTES,
    type DesktopDocumentAdmission,
    type DesktopDocumentAttachment,
    type DesktopDocumentScope,
} from '../../../../../packages/contracts/src/desktop-document-attachments.ts'
import {
    admitDesktopDocuments,
    convertDesktopDocument,
    discardDesktopDocument,
    listDesktopDocuments,
    uploadDesktopDocument,
} from './client'
import { desktopDocumentKindForName } from '../server/document-attachments/bytes'

type PendingFile = { id: string; file: File }

export function useDesktopDocumentAttachments({ agentId, tabUid, sessionId }: DesktopDocumentScope) {
    const scope = { agentId, tabUid, sessionId }
    const scopeKey = JSON.stringify(scope)
    const [attachments, setAttachments] = useState<DesktopDocumentAttachment[]>([])
    const [busy, setBusy] = useState(0)
    const [error, setError] = useState<string | null>(null)
    const [loaded, setLoaded] = useState(false)
    const files = useRef(new Map<string, PendingFile>())
    const controllers = useRef(new Map<string, AbortController>())
    const generation = useRef(0)
    const mounted = useRef(true)

    const current = useCallback((key: string, token: number) => mounted.current && key === scopeKey && generation.current === token, [scopeKey])

    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
            generation.current++
            for (const controller of controllers.current.values()) controller.abort()
            controllers.current.clear()
        }
    }, [])

    useEffect(() => {
        generation.current++
        for (const controller of controllers.current.values()) controller.abort()
        controllers.current.clear()
        setAttachments([])
        setError(null)
        setLoaded(false)
        const key = scopeKey
        const token = generation.current
        setBusy(value => value + 1)
        void listDesktopDocuments(scope).then(rows => {
            if (!current(key, token)) return
            setAttachments(rows)
            files.current.clear()
            setLoaded(true)
        }).catch(cause => {
            if (current(key, token)) setError(cause instanceof Error ? cause.message : 'Could not restore attachments.')
        }).finally(() => {
            if (current(key, token)) setBusy(value => Math.max(0, value - 1))
        })
    }, [scopeKey])

    const replace = useCallback((attachment: DesktopDocumentAttachment) => {
        setAttachments(current => current.map(item => item.attachmentId === attachment.attachmentId ? attachment : item))
    }, [])

    const convert = useCallback(async (attachment: DesktopDocumentAttachment, key: string, token: number) => {
        try {
            const controller = new AbortController()
            controllers.current.set(attachment.attachmentId, controller)
            const converted = await convertDesktopDocument(scope, attachment.attachmentId, attachment.revision, controller.signal)
            if (current(key, token)) replace(converted)
        } catch (cause) {
            if (current(key, token)) setError(cause instanceof Error ? cause.message : 'Document conversion failed.')
        } finally {
            controllers.current.delete(attachment.attachmentId)
            if (current(key, token)) setBusy(value => Math.max(0, value - 1))
        }
    }, [current, replace, scope])

    const upload = useCallback(async (pending: PendingFile, key: string, token: number) => {
        setBusy(value => value + 1)
        try {
            const controller = new AbortController()
            controllers.current.set(pending.id, controller)
            const uploaded = await uploadDesktopDocument(scope, pending.id, pending.file, controller.signal)
            if (current(key, token)) {
                replace(uploaded)
                if (uploaded.conversion.state === 'pending') await convert(uploaded, key, token)
            }
        } catch (cause) {
            if (current(key, token)) setError(cause instanceof Error ? cause.message : 'Upload failed.')
        } finally {
            controllers.current.delete(pending.id)
            if (current(key, token)) setBusy(value => Math.max(0, value - 1))
        }
    }, [convert, current, replace, scope])

    const add = useCallback((added: readonly File[]): string[] => {
        const accepted = added.filter(file => file.size > 0 && file.size <= DESKTOP_DOCUMENT_MAX_BYTES)
        if (!accepted.length) {
            setError('Choose a non-empty document up to 16 MB.')
            return []
        }
        const used = attachments.reduce((sum, item) => sum + item.byteLength, 0) + accepted.reduce((sum, file) => sum + file.size, 0)
        if (attachments.length + accepted.length > DESKTOP_DOCUMENT_MAX_FILES || used > DESKTOP_DOCUMENT_TOTAL_MAX_BYTES) {
            setError('Attachments can be up to 48 MB across ten files.')
            return []
        }
        setError(accepted.length === added.length ? null : `${added.length - accepted.length} file${added.length - accepted.length === 1 ? '' : 's'} skipped: empty or larger than 16 MB.`)
        const key = scopeKey
        const token = generation.current
        const pending = accepted.map(file => ({ id: crypto.randomUUID(), file }))
        for (const item of pending) {
            files.current.set(item.id, item)
            const now = new Date().toISOString()
            const placeholder: DesktopDocumentAttachment = {
                attachmentId: item.id,
                scope,
                name: item.file.name,
                mimeType: item.file.type || 'application/octet-stream',
                kind: desktopDocumentKindForName(item.file.name),
                byteLength: item.file.size,
                sha256: '0'.repeat(64),
                conversion: { mode: 'staged-file', state: 'pending' },
                admitted: false,
                revision: crypto.randomUUID(),
                createdAt: now,
                updatedAt: now,
            }
            setAttachments(current => [...current, placeholder])
        }
        for (const item of pending) void upload(item, key, token)
        return pending.map(item => item.id)
    }, [attachments, scope, scopeKey, upload])

    const retry = useCallback((attachmentId: string) => {
        const attachment = attachments.find(item => item.attachmentId === attachmentId)
        if (!attachment) return
        const pending = files.current.get(attachmentId)
        const key = scopeKey
        const token = generation.current
        if (pending) void upload(pending, key, token)
        else if (attachment.conversion.state !== 'ready') {
            setBusy(value => value + 1)
            void convert(attachment, key, token)
        }
    }, [attachments, convert, scopeKey, upload])

    const remove = useCallback(async (attachmentId: string): Promise<boolean> => {
        if (!attachments.some(item => item.attachmentId === attachmentId)) return true
        controllers.current.get(attachmentId)?.abort()
        const key = scopeKey
        const token = generation.current
        try {
            const saved = (await listDesktopDocuments(scope)).find(item => item.attachmentId === attachmentId)
            if (saved) await discardDesktopDocument(scope, attachmentId, saved.revision)
            if (!current(key, token)) return false
            files.current.delete(attachmentId)
            setAttachments(current => current.filter(item => item.attachmentId !== attachmentId))
            return true
        } catch (cause) {
            if (current(key, token)) setError(cause instanceof Error ? cause.message : 'This attachment is referenced and cannot be removed.')
            return false
        }
    }, [attachments, current, scope, scopeKey])

    const settle = useCallback(async (): Promise<DesktopDocumentAdmission> => {
        const result = await admitDesktopDocuments(scope)
        if (!result.allowed) setError(result.reason ?? 'An attachment is not ready to send.')
        return result
    }, [scope])

    return { attachments, busy, error, loaded, add, retry, remove, settle }
}
