'use client'

import { deleteCoworkerSkillFile, writeCoworkerSkillFile } from '@/lib/desktop/coworker-skills'
import { PanelDeleteButton } from '@/components/ui/panel-editor'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { FileTextIcon, PlusIcon } from '@/lib/icons'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'

type DesktopSkillFilesSectionProps = {
    agentId: string
    slug: string
    files: string[]
    // A connector-managed skill hides these controls entirely.
    readOnly?: boolean
    onOpen: (path: string) => void
    onChanged: () => void
}

// Port of SkillFilesSection: same labels, layout and behavior; only the data boundary changed to
// the authenticated desktop routes. The template-content lock of the web is not part of the Mac.
export function DesktopSkillFilesSection({ agentId, slug, files, readOnly, onOpen, onChanged }: DesktopSkillFilesSectionProps) {
    return <SkillFilesSection key={`${agentId}\0${slug}`} {...{ agentId, slug, files, readOnly, onOpen, onChanged }} />
}

function SkillFilesSection({ agentId, slug, files, readOnly, onOpen, onChanged }: DesktopSkillFilesSectionProps) {
    const [adding, setAdding] = useState(false)
    const [newPath, setNewPath] = useState('references/')
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    const mountedRef = useRef(true)
    const pending = useRef(false), readOnlyRef = useRef(readOnly)
    readOnlyRef.current = readOnly
    useEffect(() => {
        mountedRef.current = true
        return () => { mountedRef.current = false }
    }, [])

    const handleAdd = useCallback(async () => {
        if (!mountedRef.current || pending.current || readOnlyRef.current || isDesktopQuitting()) return
        const path = newPath.trim()
        if (!path || path.endsWith('/')) {
            setError('Enter a file path, for example references/checklist.md')
            return
        }
        setBusy(path)
        pending.current = true
        setError(null)
        // createOnly: a name that already exists is refused without ever opening the file for
        // writing, so an existing bundled file's bytes are never touched by a stray "Add".
        const result = await writeCoworkerSkillFile(agentId, slug, path, '', { createOnly: true })
        if (!mountedRef.current || isDesktopQuitting()) return
        pending.current = false
        setBusy(null)
        if (!result.success) {
            setError(result.error ?? 'Failed to create file')
            return
        }
        setAdding(false)
        setNewPath('references/')
        onChanged()
        onOpen(path)
    }, [agentId, slug, newPath, onChanged, onOpen])

    const handleDelete = useCallback(async (path: string) => {
        if (!mountedRef.current || pending.current || readOnlyRef.current || isDesktopQuitting()) return
        pending.current = true
        setBusy(path)
        setError(null)
        const result = await deleteCoworkerSkillFile(agentId, slug, path)
        if (!mountedRef.current || isDesktopQuitting()) return
        pending.current = false
        setBusy(null)
        if (!result.success) setError(result.error ?? 'Failed to delete file')
        else onChanged()
    }, [agentId, slug, onChanged])

    return (
        <Field label="Bundled files" helperText="Long checklists, banks and corpora live here. The coworker reads one only when the procedure points to it.">
            <div className="rounded-md border border-border divide-y divide-border">
                {files.length === 0 && !adding && <p className="px-2.5 py-2 text-xs text-muted-foreground">No bundled files.</p>}
                {files.map(path => (
                    <div key={path} className="flex items-center gap-1 pr-1">
                        <button type="button" disabled={!!busy} onClick={() => { if (!pending.current && !isDesktopQuitting()) onOpen(path) }} className="flex flex-1 min-w-0 items-center gap-2 px-2.5 py-2 text-left hover:bg-accent/30 transition-colors">
                            <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate text-xs font-mono">{path}</span>
                        </button>
                        {!readOnly && (
                            <PanelDeleteButton
                                label={`Delete ${path}`}
                                busy={busy === path}
                                disabled={!!busy}
                                onClick={() => handleDelete(path)}
                                confirmTitle={`Delete ${path}?`}
                                confirmDescription="The file is removed from the skill. This cannot be undone."
                            />
                        )}
                    </div>
                ))}
                {adding && (
                    <div className="flex items-center gap-1.5 p-2">
                        <div className="flex-1">
                            <Input value={newPath} onChange={e => setNewPath(e.target.value)} placeholder="references/checklist.md" className="h-8 text-xs font-mono" autoFocus disabled={!!busy} />
                        </div>
                        <Button size="sm" loading={!!busy} disabled={!!busy} onClick={handleAdd}>
                            Add
                        </Button>
                        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { setAdding(false); setError(null) }}>
                            Cancel
                        </Button>
                    </div>
                )}
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            {!readOnly && !adding && (
                <Button size="sm" variant="outline" className="w-full" disabled={!!busy} onClick={() => setAdding(true)}>
                    <PlusIcon className="size-3.5 mr-1" /> Add file
                </Button>
            )}
        </Field>
    )
}
