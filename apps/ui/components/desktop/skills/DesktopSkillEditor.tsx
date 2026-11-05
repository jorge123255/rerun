'use client'

import { createCoworkerSkill, deleteCoworkerSkill, downloadCoworkerSkillArchive, getCoworkerSkill, updateCoworkerSkill } from '@/lib/desktop/coworker-skills'
import { PanelDeleteButton, PanelEditorBody, PanelEditorFooter, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { PanelSteps } from '@/components/ui/panel-steps'
import { DesktopSkillFileEditor } from './DesktopSkillFileEditor'
import { DesktopSkillFilesSection } from './DesktopSkillFilesSection'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MarkdownTextarea } from '@/components/ui/markdown-textarea'
import { DownloadIcon } from '@/lib/icons'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'

type DesktopSkillEditorProps = {
    agentId: string
    slug?: string
    readOnly?: boolean
    onDone: () => void
    onBack: () => void
}

// Port of SkillEditor: same views, labels and actions; only the data boundary changed to the
// authenticated desktop routes. The web's template-content lock does not apply to local Mac
// coworkers, so sealed skills are exactly the connector-owned (readOnly) ones.
export function DesktopSkillEditor({ agentId, slug, readOnly, onDone, onBack }: DesktopSkillEditorProps) {
    return <SkillEditor key={`${agentId}\0${slug ?? 'new'}`} {...{ agentId, slug, readOnly, onDone, onBack }} />
}

function SkillEditor({ agentId, slug, readOnly, onDone, onBack }: DesktopSkillEditorProps) {
    const isEdit = !!slug
    const [loading, setLoading] = useState(isEdit)
    const [loadFailed, setLoadFailed] = useState(false)
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [body, setBody] = useState('')
    const [files, setFiles] = useState<string[]>([])
    const [identity, setIdentity] = useState<string | undefined>()
    const [openFile, setOpenFile] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [downloading, setDownloading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [deleting, setDeleting] = useState(false)

    const mountedRef = useRef(true)
    const mutation = useRef(false)
    const access = useRef({ readOnly, loading, loadFailed })
    access.current = { readOnly, loading, loadFailed }
    useEffect(() => {
        mountedRef.current = true
        return () => { mountedRef.current = false }
    }, [])

    // The procedure body loads once: returning from a bundled-file edit only refreshes the file
    // list, so an unsaved draft in the procedure editor is never discarded.
    const loadBody = useCallback(async () => {
        if (!slug) return
        const skill = await getCoworkerSkill(agentId, slug)
        if (!mountedRef.current) return
        if (skill) {
            setName(skill.name)
            setDescription(skill.description ?? '')
            setBody(skill.body ?? '')
            setFiles(skill.files ?? [])
            setIdentity(skill.identity)
        } else {
            setLoadFailed(true)
            setError('Could not load this skill')
        }
        setLoading(false)
    }, [agentId, slug])

    useEffect(() => {
        loadBody()
    }, [loadBody])

    const refreshFiles = useCallback(async () => {
        if (!slug) return
        const skill = await getCoworkerSkill(agentId, slug)
        if (!mountedRef.current) return
        if (skill) setFiles(skill.files ?? [])
    }, [agentId, slug])

    // Per-operation generations: a save, download or delete that lands after the editor was
    // unmounted (or superseded by another click of the same button) never touches state.
    const saveGeneration = useRef(0)
    const handleSave = useCallback(async () => {
        if (!mountedRef.current || mutation.current || access.current.readOnly || access.current.loading || access.current.loadFailed || (isEdit && !identity) || isDesktopQuitting()) return
        mutation.current = true
        const generation = ++saveGeneration.current
        setSaving(true)
        setError(null)
        const result = isEdit ? await updateCoworkerSkill(agentId, slug!, { description, body, baseIdentity: identity }) : await createCoworkerSkill(agentId, { name, description, body })
        if (!mountedRef.current || saveGeneration.current !== generation || isDesktopQuitting()) return
        mutation.current = false
        setSaving(false)
        if (result.success) onDone()
        else setError(result.error ?? 'Failed to save')
    }, [agentId, slug, isEdit, name, description, body, identity, onDone])

    const downloadGeneration = useRef(0)
    const handleDownload = useCallback(async () => {
        if (!mountedRef.current || mutation.current || access.current.loading || access.current.loadFailed || isDesktopQuitting()) return
        if (files.length === 0) {
            const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`
            downloadBlob(new Blob([content], { type: 'text/markdown' }), `${slug}.md`)
            return
        }
        const generation = ++downloadGeneration.current
        setDownloading(true)
        setError(null)
        const result = await downloadCoworkerSkillArchive(agentId, slug!)
        if (!mountedRef.current || downloadGeneration.current !== generation || isDesktopQuitting()) return
        setDownloading(false)
        if (!result.success || !result.base64) {
            setError(result.error ?? 'Failed to download skill')
            return
        }
        const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0))
        downloadBlob(new Blob([bytes], { type: 'application/gzip' }), `${slug}.tar.gz`)
    }, [agentId, slug, name, description, body, files.length])

    const deleteGeneration = useRef(0)
    const handleDelete = useCallback(async () => {
        if (!mountedRef.current || mutation.current || access.current.readOnly || isDesktopQuitting()) return
        mutation.current = true
        const generation = ++deleteGeneration.current
        setDeleting(true)
        const result = await deleteCoworkerSkill(agentId, slug!)
        if (!mountedRef.current || deleteGeneration.current !== generation || isDesktopQuitting()) return
        mutation.current = false
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
                <DesktopSkillFileEditor
                    agentId={agentId}
                    slug={slug}
                    path={openFile}
                    readOnly={readOnly}
                    onBack={() => {
                        setOpenFile(null)
                        refreshFiles()
                    }}
                />
            </PanelSteps>
        )
    }

    return (
        <PanelSteps stepKey="skill" depth={0}>
            <PanelEditorShell>
                <PanelEditorHeader title={readOnly ? 'Skill' : isEdit ? 'Edit skill' : 'New skill'} onBack={saving || deleting ? undefined : onBack}>
                    {isEdit && !readOnly && (
                        <Button size="icon-sm" variant="ghost" loading={downloading} onClick={handleDownload} title="Download skill" aria-label="Download skill">
                            <DownloadIcon className="size-4" />
                        </Button>
                    )}
                </PanelEditorHeader>
                <PanelEditorBody>
                    {error && <p className="text-xs text-destructive">{error}</p>}
                    {readOnly && <p className="text-xs text-muted-foreground">This skill is provided by an app and is managed automatically.</p>}
                    <Input label="Name" helperText={isEdit && !readOnly ? "Name can't be changed (it sets the slug)." : undefined} hideRequired value={name} onChange={e => setName(e.target.value)} disabled={isEdit || readOnly || saving || deleting} placeholder="Web Research" className="h-8 text-sm" />
                    {isEdit && !readOnly && !identity && <p role="alert" className="text-xs text-destructive">Could not confirm this skill’s saved version. Reopen it before saving changes.</p>}
                    <Input label="Description" hideRequired value={description} onChange={e => setDescription(e.target.value)} disabled={readOnly || saving || deleting} placeholder="How to research a topic" className="h-8 text-sm" />
                    <MarkdownTextarea label="Procedure" dialogTitle="Edit the procedure" value={body} onChange={setBody} disabled={readOnly || saving || deleting} className="text-xs min-h-48 font-mono" placeholder={'1. Identify sources\n2. Fetch\n3. Summarize'} />
                    {isEdit && <DesktopSkillFilesSection agentId={agentId} slug={slug!} files={files} readOnly={readOnly || saving || deleting} onOpen={path => { if (!mutation.current) setOpenFile(path) }} onChanged={refreshFiles} />}
                </PanelEditorBody>
                {!readOnly && (
                    <PanelEditorFooter>
                        {isEdit && (
                            <PanelDeleteButton
                                label="Delete skill"
                                busy={deleting}
                                disabled={saving || deleting}
                                onClick={handleDelete}
                                confirmTitle={`Delete ${name || 'this skill'}?`}
                                confirmDescription="The skill and every file bundled with it are removed from the coworker. This cannot be undone."
                            />
                        )}
                        <Button size="sm" className="flex-1" loading={saving} onClick={handleSave} disabled={!name.trim() || loadFailed || saving || deleting || (isEdit && !identity)}>
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
