'use client'

import type { SaveFileResult } from '@/app/api/_services/file.service'
import { applyEol, hashText, splitEol, type Eol } from '@/lib/files/editable'
import { useCallback, useState } from 'react'
import { useFileUnloadGuard, type FileDraftHost } from './useFileUnloadGuard'

type UseFileDraftProps = {
    initialContent: string
    onSave: (content: string, baseHash: string | null) => Promise<SaveFileResult>
    onSaved: (content: string) => void
    host?: FileDraftHost
}

export type FileDraft = {
    draft: string
    dirty: boolean
    saving: boolean
    error: string | null
    conflict: boolean
    setDraft: (next: string) => void
    save: () => void
    overwrite: () => void
    dismissConflict: () => void
}

export function useFileDraft({ initialContent, onSave, onSaved, host }: UseFileDraftProps): FileDraft {
    const [opened, setOpened] = useState(() => splitEol(initialContent))
    const [draft, setText] = useState(opened.text)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [conflict, setConflict] = useState(false)

    const dirty = draft !== opened.text

    useFileUnloadGuard(dirty, host)
    const setDraft = useCallback((text: string) => {
        if (!host?.isClosing()) setText(text)
    }, [host])

    const run = useCallback(
        async (eol: Eol, baseHash: string | null) => {
            if (host?.isClosing()) return
            const content = applyEol(draft, eol)
            setSaving(true)
            setError(null)
            const result = await onSave(content, baseHash)
            setSaving(false)
            if (result.success) {
                setOpened({ text: draft, eol })
                setConflict(false)
                onSaved(content)
                return
            }
            if (result.conflict) setConflict(true)
            else setError(result.error)
        },
        [draft, host, onSave, onSaved],
    )

    const save = useCallback(() => {
        if (saving) return
        void run(opened.eol, hashText(applyEol(opened.text, opened.eol)))
    }, [run, saving, opened])

    const overwrite = useCallback(() => {
        setConflict(false)
        void run(opened.eol, null)
    }, [run, opened])

    const dismissConflict = useCallback(() => setConflict(false), [])

    return { draft, dirty, saving, error, conflict, setDraft, save, overwrite, dismissConflict }
}
