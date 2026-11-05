'use client'

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { desktopAttachmentFieldsOf, desktopAttachmentSelectionsOf as desktopAttachmentPathsOf, type DesktopAttachmentFields } from '@rerun/contracts'
import { clearDesktopDraft, desktopDraftRecord, invalidateDesktopDraft, isDesktopQuitting, keepDesktopDraft, reloadDesktopDraft, saveDesktopDraft, subscribeDraftShutdown, updateDesktopDraft, type ComposerValue, type DraftState } from './draft-writes'

const noState: DraftState = { text: '', loaded: true, saving: false, version: 0, conflict: false }
const noop = () => () => {}

export function useDesktopComposerDraft(agentId: string, tabUid: string | undefined, restore: (draft: ComposerValue) => void) {
    const quitting = useSyncExternalStore(subscribeDraftShutdown, isDesktopQuitting, () => false)
    const record = useMemo(() => tabUid ? desktopDraftRecord(agentId, tabUid) : null, [agentId, tabUid])
    const restoreRef = useRef(restore)
    restoreRef.current = restore
    const subscribe = useCallback((listener: () => void) => {
        if (!record) return noop()
        record.listeners.add(listener)
        return () => { record.listeners.delete(listener) }
    }, [record])
    const snapshot = useCallback(() => record?.state ?? noState, [record])
    const state = useSyncExternalStore(subscribe, snapshot, snapshot)
    const restored = useRef<unknown>(null)
    useEffect(() => { if (record) void saveDesktopDraft(record) }, [record])
    useEffect(() => {
        if (!record || !state.loaded) { restored.current = null; return }
        if (restored.current === record) return
        restored.current = record
        restoreRef.current({ text: state.text, ...desktopAttachmentFieldsOf(desktopAttachmentPathsOf(state as DesktopAttachmentFields)) })
    }, [record, state.loaded, state.text, state.attachmentPath, state.attachmentPaths, state.attachmentItems])
    const update = useCallback((draft: ComposerValue) => { if (record) updateDesktopDraft(record, draft) }, [record])
    const clear = useCallback((version: number) => !record || clearDesktopDraft(record, version), [record])
    const flush = useCallback(async () => {
        if (!record) return true
        await saveDesktopDraft(record)
        return record.state.loaded && !record.state.error && !record.state.conflict && !record.dirty
    }, [record])
    const reload = useCallback(async () => {
        if (!record) return
        restored.current = null
        await reloadDesktopDraft(record)
    }, [record])
    const invalidate = useCallback((error: string) => { if (record) invalidateDesktopDraft(record, error) }, [record])
    return { ...state, quitting, update, clear, flush, reload, invalidate,
        retry: () => record && saveDesktopDraft(record), keep: () => record && keepDesktopDraft(record) }
}
