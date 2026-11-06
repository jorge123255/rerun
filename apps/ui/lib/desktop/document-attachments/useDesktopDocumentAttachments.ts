'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DESKTOP_DOCUMENT_MAX_BYTES, DESKTOP_DOCUMENT_MAX_FILES, DESKTOP_DOCUMENT_TOTAL_MAX_BYTES, type DesktopDocumentAttachment, type DesktopDocumentScope, type DesktopDocumentSelection, type DesktopDocumentSendSelection } from '@rerun/contracts'
import { holdDraftAdmission, isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { admitDesktopDocuments, cancelDesktopDocumentUpload, consumeDesktopDocuments, convertDesktopDocument, discardDesktopDocument, detachDesktopDocument, listDesktopDocuments } from './client'
import { canRetainDocuments, documentPlaceholder, documentScopeKey, forgetRetainedDocument, retainedDocument, retainedDocuments, retainDocument, saveRetainedDocument, subscribeRetainedDocuments } from './retained'

export function useDesktopDocumentAttachments({ agentId, tabUid, sessionId, enabled = true }: DesktopDocumentScope & { enabled?: boolean }) {
    const scope = useMemo(() => ({ agentId, tabUid, ...(sessionId ? { sessionId } : {}) }), [agentId, tabUid, sessionId])
    const scopeKey = documentScopeKey(scope), latest = useRef(scopeKey); latest.current = scopeKey
    const [attachments, setAttachments] = useState<DesktopDocumentAttachment[]>([]), rows = useRef(attachments); rows.current = attachments
    const [error, setError] = useState<string | null>(null), [loaded, setLoaded] = useState(false), [pending, setPending] = useState<Set<string>>(new Set())
    const mounted = useRef(true), generation = useRef(0), operations = useRef(new Map<string, AbortController>()), selection = useRef<DesktopDocumentSendSelection | null>(null)
    const current = useCallback((key: string, token: number) => mounted.current && latest.current === key && generation.current === token, [])
    const update = useCallback((next: DesktopDocumentAttachment) => { setAttachments(old => { const found = old.some(a => a.attachmentId === next.attachmentId); return (found ? old.map(a => a.attachmentId === next.attachmentId ? next : a) : [...old, next]).sort((a, b) => a.position - b.position) }) }, [])
    const refresh = useCallback(async (key = scopeKey, token = generation.current) => {
        const saved = await listDesktopDocuments(scope)
        if (!current(key, token)) return
        const raw = retainedDocuments(scope).map(documentPlaceholder)
        const merged = [...saved.filter(a => !raw.some(r => r.attachmentId === a.attachmentId)), ...raw].sort((a, b) => a.position - b.position)
        rows.current = merged; setAttachments(merged); setLoaded(true)
    }, [current, scope, scopeKey])
    useEffect(() => {
        mounted.current = true; generation.current++
        const key = scopeKey, token = generation.current
        selection.current = null; setPending(new Set()); setLoaded(false); setError(null)
        const raw = retainedDocuments(scope).map(documentPlaceholder); rows.current = raw; setAttachments(raw)
        void refresh(key, token).catch(error => { if (current(key, token)) setError(error instanceof Error ? error.message : 'Could not restore attachments.') })
        const unsubscribe = subscribeRetainedDocuments(record => {
            if (!current(key, token) || documentScopeKey(record.scope) !== key) return
            update(documentPlaceholder(record))
            setPending(old => { const next = new Set(old); record.work ? next.add(record.id) : next.delete(record.id); return next })
            if (record.error) setError(record.error)
        })
        for (const item of retainedDocuments(scope)) if (item.work) setPending(old => new Set(old).add(item.id))
        return () => { mounted.current = false; generation.current++; unsubscribe(); for (const controller of operations.current.values()) controller.abort(); operations.current.clear() }
    }, [scope, scopeKey, current, refresh, update])
    const add = useCallback((files: readonly File[]) => {
        if (!enabled || !loaded || isDesktopQuitting()) return []
        if (!files.length || files.some(file => !file.size || file.size > DESKTOP_DOCUMENT_MAX_BYTES)) { setError('Choose non-empty documents up to 16 MB each. Nothing was attached.'); return [] }
        if (rows.current.length + files.length > DESKTOP_DOCUMENT_MAX_FILES || [...rows.current.map(a => a.byteLength), ...files.map(f => f.size)].reduce((a, b) => a + b, 0) > DESKTOP_DOCUMENT_TOTAL_MAX_BYTES) { setError('Attachments can be up to 48 MB across ten files.'); return [] }
        if (!canRetainDocuments(files)) { setError('Save or remove pending attachments before adding more.'); return [] }
        selection.current = null; setError(null)
        let position = Math.max(-1, ...rows.current.map(a => a.position)) + 1
        const records = files.map(file => retainDocument(scope, file, position++))
        rows.current = [...rows.current, ...records.map(documentPlaceholder)]; setAttachments(rows.current)
        for (const record of records) void saveRetainedDocument(record)
        return records.map(record => record.id)
    }, [enabled, loaded, scope])
    const work = useCallback(async (id: string, action: (attachment: DesktopDocumentAttachment, signal: AbortSignal) => Promise<void>) => {
        if (!enabled || isDesktopQuitting() || operations.current.has(id)) return
        const key = scopeKey, token = generation.current, controller = new AbortController(), release = holdDraftAdmission()
        operations.current.set(id, controller); setPending(old => new Set(old).add(id)); setError(null)
        try {
            const raw = retainedDocument(id)
            if (raw) { const saved = await saveRetainedDocument(raw); if (!saved) throw new Error(raw.error ?? 'Save this file before removing its exact attempt.'); if (current(key, token)) update(saved) }
            if (!current(key, token)) return
            const saved = (await listDesktopDocuments(scope, controller.signal)).find(a => a.attachmentId === id)
            if (!saved) throw new Error('This attachment is no longer selected.')
            await action(saved, controller.signal)
            if (current(key, token)) { selection.current = null; await refresh(key, token) }
        } catch (error) {
            if (current(key, token)) { await refresh(key, token).catch(() => {}); setError(error instanceof Error ? error.message : 'Attachment request did not finish.') }
        } finally { if (operations.current.get(id) === controller) operations.current.delete(id); if (current(key, token)) setPending(old => { const next = new Set(old); next.delete(id); return next }); release() }
    }, [current, enabled, refresh, scope, scopeKey, update])
    // Explicit user action; attaching or restoring never calls a paid converter.
    const prepare = useCallback((id: string) => work(id, async (a, signal) => { await convertDesktopDocument(a.scope, id, a.revision, signal) }), [work])
    const retry = useCallback(async (id: string) => {
        const raw = retainedDocument(id)
        if (raw) { await saveRetainedDocument(raw); return }
        await prepare(id)
    }, [prepare])
    const remove = useCallback(async (id: string) => {
        const raw = retainedDocument(id)
        if (!raw) return work(id, async (a, signal) => {
            if (a.admitted) await detachDesktopDocument(a.scope, id, a.revision, signal)
            else await discardDesktopDocument(a.scope, id, a.revision, signal)
        })
        if (!enabled || raw.work || operations.current.has(id)) return
        const key = scopeKey, token = generation.current, controller = new AbortController(), release = holdDraftAdmission()
        operations.current.set(id, controller); setPending(old => new Set(old).add(id))
        try {
            await cancelDesktopDocumentUpload(raw.scope, id, controller.signal)
            forgetRetainedDocument(id)
            if (current(key, token)) { selection.current = null; await refresh(key, token) }
        } catch (error) { if (current(key, token)) setError(error instanceof Error ? error.message : 'Could not remove this upload. Retry the same attempt.') }
        finally { if (operations.current.get(id) === controller) operations.current.delete(id); if (current(key, token)) setPending(old => { const next = new Set(old); next.delete(id); return next }); release() }
    }, [current, enabled, refresh, scopeKey, work])
    const settle = useCallback(async (modelChoice?: DesktopDocumentSelection['modelChoice']): Promise<{ selection: DesktopDocumentSendSelection; admission: Awaited<ReturnType<typeof admitDesktopDocuments>> } | null> => {
        const key = scopeKey, token = generation.current
        if (!loaded || pending.size || operations.current.size || retainedDocuments(scope).length || isDesktopQuitting()) throw new Error('Wait for all selected attachments to finish saving.')
        if (!rows.current.length) return null
        if (rows.current.some(a => !a.uploaded || a.conversion.state !== 'ready')) throw new Error('Prepare the selected attachments before sending.')
        const ids = rows.current.map(a => a.attachmentId)
        const previous = selection.current
        if (!previous || JSON.stringify([previous.attachmentIds, previous.modelChoice ?? null]) !== JSON.stringify([ids, modelChoice ?? null])) selection.current = { scope, admissionId: crypto.randomUUID(), attachmentIds: ids, ...(modelChoice && { modelChoice: { ...modelChoice } }) }
        const selected = selection.current!
        const { scope: original, ...input } = selected
        const release = holdDraftAdmission()
        try {
            const admission = await admitDesktopDocuments(original, input)
            if (!current(key, token)) throw new Error('The selected conversation changed.')
            if (!admission.allowed) throw new Error(admission.reason ?? 'The attachments are not ready.')
            return { selection: selected, admission }
        } finally { release() }
    }, [current, loaded, pending.size, scope, scopeKey])
    const consumed = useCallback(async (selected: DesktopDocumentSendSelection) => {
        await consumeDesktopDocuments(selected.scope, selected.admissionId)
        if (latest.current === documentScopeKey(selected.scope)) { selection.current = null; await refresh() }
    }, [refresh])
    return { attachments, busy: pending.size, error, loaded, add, prepare, retry, remove, settle, consumed, refresh }
}
