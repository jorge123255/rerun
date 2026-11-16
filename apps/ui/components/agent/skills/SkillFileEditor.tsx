'use client'

import { deleteSkillFileAction, readSkillFileAction, writeSkillFileAction } from '@/app/api/_actions/agent.actions'
import { PanelDeleteButton, PanelEditorBody, PanelEditorFooter, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useCallback, useEffect, useState } from 'react'

type SkillFileEditorProps = {
    agentId: string
    slug: string
    path: string
    readOnly?: boolean
    onBack: () => void
}

export function SkillFileEditor({ agentId, slug, path, readOnly: readOnlyProp, onBack }: SkillFileEditorProps) {
    const readOnly = !!readOnlyProp
    const [loading, setLoading] = useState(true)
    const [content, setContent] = useState('')
    const [truncated, setTruncated] = useState(false)
    const [saving, setSaving] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        setLoading(true)
        readSkillFileAction(agentId, slug, path)
            .then(result => {
                if (result) {
                    setContent(result.content)
                    setTruncated(result.truncated)
                } else {
                    setError('Could not read this file')
                }
            })
            .finally(() => setLoading(false))
    }, [agentId, slug, path])

    const handleSave = useCallback(async () => {
        setSaving(true)
        setError(null)
        const result = await writeSkillFileAction(agentId, slug, path, content)
        setSaving(false)
        if (result.success) onBack()
        else setError(result.error ?? 'Failed to save')
    }, [agentId, slug, path, content, onBack])

    const handleDelete = useCallback(async () => {
        setDeleting(true)
        setError(null)
        const result = await deleteSkillFileAction(agentId, slug, path)
        setDeleting(false)
        if (result.success) onBack()
        else setError(result.error ?? 'Failed to delete')
    }, [agentId, slug, path, onBack])

    return (
        <PanelEditorShell>
            <PanelEditorHeader title={path} onBack={onBack} mono />
            <PanelEditorBody>
                {error && <p className="text-xs text-destructive">{error}</p>}
                {truncated && <p className="text-xs text-muted-foreground">This file is too large to edit here; only its first 100 000 characters are shown.</p>}
                {loading ? (
                    <SkeletonRows rows={8} />
                ) : (
                    <Textarea value={content} onChange={e => setContent(e.target.value)} disabled={readOnly || truncated} className="text-xs min-h-96 font-mono" />
                )}
            </PanelEditorBody>
            {!readOnlyProp && (
                <PanelEditorFooter>
                    <PanelDeleteButton
                        label="Delete file"
                        busy={deleting}
                        onClick={handleDelete}
                        confirmTitle={`Delete ${path}?`}
                        confirmDescription="The file is removed from the skill. This cannot be undone."
                    />
                    <Button size="sm" className="flex-1" loading={saving} onClick={handleSave} disabled={loading || truncated}>
                        Save changes
                    </Button>
                </PanelEditorFooter>
            )}
        </PanelEditorShell>
    )
}
