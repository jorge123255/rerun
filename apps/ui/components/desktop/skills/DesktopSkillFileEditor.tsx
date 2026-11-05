'use client'

import { deleteCoworkerSkillFile, readCoworkerSkillFile, writeCoworkerSkillFile } from '@/lib/desktop/coworker-skills'
import { skillEditorOperationApplies } from '@/lib/desktop/skill-editor-operation'
import { PanelDeleteButton, PanelEditorBody, PanelEditorFooter, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'

type DesktopSkillFileEditorProps = {
    agentId: string
    slug: string
    path: string
    readOnly?: boolean
    onBack: () => void
}

// Port of SkillFileEditor: same layout and 100 000-character page cap; only the data boundary
// changed to the authenticated desktop routes. The template-content lock of the web is not part of
// the Mac.
export function DesktopSkillFileEditor({ agentId, slug, path, readOnly, onBack }: DesktopSkillFileEditorProps) {
    return <SkillFileEditor key={`${agentId}\0${slug}\0${path}`} {...{ agentId, slug, path, readOnly, onBack }} />
}

function SkillFileEditor({ agentId, slug, path, readOnly, onBack }: DesktopSkillFileEditorProps) {
    const [loading, setLoading] = useState(true)
    const [loadFailed, setLoadFailed] = useState(false)
    const [content, setContent] = useState('')
    const [truncated, setTruncated] = useState(false)
    const [identity, setIdentity] = useState<string | undefined>(undefined)
    const [saving, setSaving] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const owner = `${agentId}\0${slug}\0${path}`
    const generation = useRef(0)
    const mounted = useRef(false)
    const ownerRef = useRef(owner)
    ownerRef.current = owner
    const pending = useRef(false)
    const access = useRef({ readOnly, loading, loadFailed, truncated })
    access.current = { readOnly, loading, loadFailed, truncated }

    const applies = useCallback((captured: { generation: number; owner: string }) => {
        return !isDesktopQuitting() && skillEditorOperationApplies(
            { mounted: mounted.current, generation: generation.current, owner: ownerRef.current },
            captured,
        )
    }, [])

    useEffect(() => {
        const captured = { generation: ++generation.current, owner }
        mounted.current = true
        setLoading(true)
        setLoadFailed(false)
        setSaving(false); setDeleting(false); setError(null); setContent(''); setIdentity(undefined); setTruncated(false)
        readCoworkerSkillFile(agentId, slug, path)
            .then(result => {
                if (!applies(captured)) return
                if (result) {
                    setContent(result.content)
                    setTruncated(result.truncated)
                    setIdentity(result.identity)
                } else {
                    setLoadFailed(true)
                    setError('Could not read this file')
                }
            })
            .catch(() => {
                if (!applies(captured)) return
                setLoadFailed(true)
                setError('Could not read this file')
            })
            .finally(() => { if (applies(captured)) setLoading(false) })
        return () => {
            mounted.current = false
            generation.current += 1
        }
    }, [agentId, slug, path, owner, applies])

    const handleSave = useCallback(async () => {
        const current = access.current
        if (!mounted.current || pending.current || current.readOnly || current.loading || current.loadFailed || current.truncated || !identity || isDesktopQuitting()) return
        pending.current = true
        const captured = { generation: ++generation.current, owner: ownerRef.current }
        setSaving(true)
        setError(null)
        const result = await writeCoworkerSkillFile(agentId, slug, path, content, { baseIdentity: identity, completeRead: true })
        if (!applies(captured)) return
        pending.current = false
        setSaving(false)
        if (result.success) onBack()
        else setError(result.error ?? 'Failed to save')
    }, [agentId, slug, path, content, identity, onBack, applies])

    const handleDelete = useCallback(async () => {
        if (!mounted.current || pending.current || access.current.readOnly || access.current.loading || isDesktopQuitting()) return
        pending.current = true
        const captured = { generation: ++generation.current, owner: ownerRef.current }
        setDeleting(true)
        setError(null)
        const result = await deleteCoworkerSkillFile(agentId, slug, path)
        if (!applies(captured)) return
        pending.current = false
        setDeleting(false)
        if (result.success) onBack()
        else setError(result.error ?? 'Failed to delete')
    }, [agentId, slug, path, onBack, applies])

    return (
        <PanelEditorShell>
            <PanelEditorHeader title={path} onBack={saving || deleting ? undefined : onBack} mono />
            <PanelEditorBody>
                {error && <p className="text-xs text-destructive">{error}</p>}
                {truncated && <p className="text-xs text-muted-foreground">This file is too large to edit here; only its first 100 000 characters are shown.</p>}
                {!loading && !loadFailed && !readOnly && !identity && <p role="alert" className="text-xs text-destructive">Could not confirm this file’s saved version. Reopen it before saving changes.</p>}
                {loading ? (
                    <SkeletonRows rows={8} />
                ) : (
                    <Textarea value={content} onChange={e => setContent(e.target.value)} disabled={readOnly || truncated || loadFailed || saving || deleting} className="text-xs min-h-96 font-mono" />
                )}
            </PanelEditorBody>
            {!readOnly && (
                <PanelEditorFooter>
                    <PanelDeleteButton
                        label="Delete file"
                        busy={deleting}
                        disabled={loading || saving || deleting}
                        onClick={handleDelete}
                        confirmTitle={`Delete ${path}?`}
                        confirmDescription="The file is removed from the skill. This cannot be undone."
                    />
                    <Button size="sm" className="flex-1" loading={saving} onClick={handleSave} disabled={loading || truncated || loadFailed || !identity || saving || deleting}>
                        Save changes
                    </Button>
                </PanelEditorFooter>
            )}
        </PanelEditorShell>
    )
}
