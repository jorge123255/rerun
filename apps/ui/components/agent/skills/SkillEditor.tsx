'use client'

import { createSkillAction, deleteSkillAction, downloadSkillArchiveAction, getSkillAction, updateSkillAction } from '@/app/api/_actions/agent.actions'
import { PanelDeleteButton, PanelEditorBody, PanelEditorFooter, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { PanelSteps } from '@/components/ui/panel-steps'
import { SkillFileEditor } from '@/components/agent/skills/SkillFileEditor'
import { SkillFilesSection } from '@/components/agent/skills/SkillFilesSection'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MarkdownTextarea } from '@/components/ui/markdown-textarea'
import { DownloadIcon } from '@/lib/icons'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useCallback, useEffect, useState } from 'react'

type SkillEditorProps = {
    agentId: string
    slug?: string
    readOnly?: boolean
    onDone: () => void
    onBack: () => void
}

export function SkillEditor({ agentId, slug, readOnly: readOnlyProp, onDone, onBack }: SkillEditorProps) {
    const isEdit = !!slug
    const readOnly = !!readOnlyProp
    const [loading, setLoading] = useState(isEdit)
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [body, setBody] = useState('')
    const [files, setFiles] = useState<string[]>([])
    const [openFile, setOpenFile] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [downloading, setDownloading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [deleting, setDeleting] = useState(false)

    const load = useCallback(async () => {
        if (!slug) return
        const skill = await getSkillAction(agentId, slug)
        if (skill) {
            setName(skill.name)
            setDescription(skill.description ?? '')
            setBody(skill.body ?? '')
            setFiles(skill.files ?? [])
        }
        setLoading(false)
    }, [agentId, slug])

    useEffect(() => {
        load()
    }, [load])

    const handleSave = useCallback(async () => {
        setSaving(true)
        setError(null)
        const result = isEdit ? await updateSkillAction(agentId, slug!, { description, body }) : await createSkillAction(agentId, { name, description, body })
        setSaving(false)
        if (result.success) onDone()
        else setError(result.error ?? 'Failed to save')
    }, [agentId, slug, isEdit, name, description, body, onDone])

    const handleDownload = useCallback(async () => {
        if (files.length === 0) {
            const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`
            downloadBlob(new Blob([content], { type: 'text/markdown' }), `${slug}.md`)
            return
        }
        setDownloading(true)
        setError(null)
        const result = await downloadSkillArchiveAction(agentId, slug!)
        setDownloading(false)
        if (!result.success || !result.base64) {
            setError(result.error ?? 'Failed to download skill')
            return
        }
        const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0))
        downloadBlob(new Blob([bytes], { type: 'application/gzip' }), `${slug}.tar.gz`)
    }, [agentId, slug, name, description, body, files.length])

    const handleDelete = useCallback(async () => {
        setDeleting(true)
        const result = await deleteSkillAction(agentId, slug!)
        setDeleting(false)
        if (result.success) onDone()
        else setError(result.error ?? 'Failed to delete')
    }, [agentId, slug, onDone])

    if (loading) {
        return (
            <div className="p-3">
                <SkeletonRows rows={6} />
            </div>
        )
    }

    if (openFile && slug) {
        return (
            <PanelSteps stepKey={`file:${openFile}`} depth={1}>
                <SkillFileEditor
                    agentId={agentId}
                    slug={slug}
                    path={openFile}
                    readOnly={readOnlyProp}
                    onBack={() => {
                        setOpenFile(null)
                        load()
                    }}
                />
            </PanelSteps>
        )
    }

    return (
        <PanelSteps stepKey="skill" depth={0}>
            <PanelEditorShell>
                <PanelEditorHeader title={readOnly ? 'Skill' : isEdit ? 'Edit skill' : 'New skill'} onBack={onBack}>
                    {isEdit && !readOnlyProp && (
                        <Button size="icon-sm" variant="ghost" loading={downloading} onClick={handleDownload} title="Download skill" aria-label="Download skill">
                            <DownloadIcon className="size-4" />
                        </Button>
                    )}
                </PanelEditorHeader>
                <PanelEditorBody>
                    {error && <p className="text-xs text-destructive">{error}</p>}
                    {readOnlyProp && <p className="text-xs text-muted-foreground">This skill is provided by an app and is managed automatically.</p>}
                    <Input label="Name" helperText={isEdit && !readOnly ? "Name can't be changed (it sets the slug)." : undefined} hideRequired value={name} onChange={e => setName(e.target.value)} disabled={isEdit || readOnly} placeholder="Web Research" className="h-8 text-sm" />
                    <Input label="Description" hideRequired value={description} onChange={e => setDescription(e.target.value)} disabled={readOnly} placeholder="How to research a topic" className="h-8 text-sm" />
                    <MarkdownTextarea label="Procedure" dialogTitle="Edit the procedure" value={body} onChange={setBody} disabled={readOnly} className="text-xs min-h-48 font-mono" placeholder={'1. Identify sources\n2. Fetch\n3. Summarize'} />
                    {isEdit && <SkillFilesSection agentId={agentId} slug={slug!} files={files} readOnly={readOnlyProp} onOpen={setOpenFile} onChanged={load} />}
                </PanelEditorBody>
                {!readOnlyProp && (
                    <PanelEditorFooter>
                        {isEdit && (
                            <PanelDeleteButton
                                label="Delete skill"
                                busy={deleting}
                                onClick={handleDelete}
                                confirmTitle={`Delete ${name || 'this skill'}?`}
                                confirmDescription="The skill and every file bundled with it are removed from the coworker. This cannot be undone."
                            />
                        )}
                        <Button size="sm" className="flex-1" loading={saving} onClick={handleSave} disabled={!name.trim()}>
                            {isEdit ? 'Save changes' : 'Create skill'}
                        </Button>
                    </PanelEditorFooter>
                )}
            </PanelEditorShell>
        </PanelSteps>
    )
}

function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
}
