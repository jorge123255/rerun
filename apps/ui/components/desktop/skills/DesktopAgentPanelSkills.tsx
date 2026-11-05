'use client'

import { importCoworkerSkill, listCoworkerSkills } from '@/lib/desktop/coworker-skills'
import { useCoworkerSkillProposals } from '@/lib/desktop/use-coworker-skill-proposals'
import { DesktopSkillEditor } from './DesktopSkillEditor'
import { DesktopSkillProposalReview } from './DesktopSkillProposalReview'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { EngineSkillWithSource } from '@/lib/engine/types'
import { BlocksIcon, FileTextIcon, FolderUpIcon, Layers, Loader2Icon, PlusIcon, UploadIcon } from '@/lib/icons'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelList, PanelListHeader, PanelScroller } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSteps } from '@/components/ui/panel-steps'
import { SkeletonPanelRows } from '@/components/ui/skeleton'
import { Badge } from '@rerun/ui/primitives'
import { MAX_SKILL_FILE_BYTES, readSkillFolders } from '@/lib/skills/folder-import'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'

type DesktopAgentPanelSkillsProps = {
    agentId: string
    focusSlug?: string | null
    onFocusConsumed?: () => void
}

type View = { mode: 'list' } | { mode: 'create' } | { mode: 'edit'; slug: string; readOnly: boolean }

// Port of AgentPanelSkills: the same list, upload, create and drill-in views, reading and writing
// through the authenticated desktop routes instead of the web server actions. Above the shelf sits
// the coworker's proposal review; the chat also uses the original composer dock. The web feeds a
// global skill-summary store for the composer `/` menu; the desktop
// composer does not consume it, so it is left out here.
export function DesktopAgentPanelSkills({ agentId, focusSlug, onFocusConsumed }: DesktopAgentPanelSkillsProps) {
    const [skills, setSkills] = useState<EngineSkillWithSource[]>([])
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [view, setView] = useState<View>({ mode: 'list' })
    const [importing, setImporting] = useState(false)
    const [importError, setImportError] = useState<string | null>(null)
    const [importNotice, setImportNotice] = useState<string | null>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const folderInputRef = useRef<HTMLInputElement>(null)

    // Kept in refs rather than in load's deps: the slug is honoured once, and the callback comes
    // inline from the panel, so a fresh identity on every render would refetch forever.
    const requestedSlugRef = useRef(focusSlug ?? null)
    const consumeRequestedRef = useRef(onFocusConsumed)
    useEffect(() => {
        consumeRequestedRef.current = onFocusConsumed
    })
    // A proposal applying while the panel is gone must not setState on an unmounted tree; the load
    // it triggers is gated on this instead.
    const mountedRef = useRef(true)
    const loadEpoch = useRef(0), importingRef = useRef(false)
    useEffect(() => {
        mountedRef.current = true
        return () => { mountedRef.current = false; loadEpoch.current++ }
    }, [])

    const load = useCallback(async () => {
        if (!mountedRef.current) return
        const epoch = ++loadEpoch.current
        setLoading(true)
        let list: EngineSkillWithSource[]
        try { list = await listCoworkerSkills(agentId) }
        catch (cause) {
            if (!mountedRef.current || epoch !== loadEpoch.current || isDesktopQuitting()) return
            setLoadError(cause instanceof Error ? cause.message : 'Could not load skills. Try again.')
            setLoading(false)
            return
        }
        if (!mountedRef.current || epoch !== loadEpoch.current || isDesktopQuitting()) return
        setLoadError(null)
        setSkills(list)
        // Resolved here rather than in an effect: the row carries the readOnly flag, so the drill-in
        // has to wait for the list anyway.
        const requested = requestedSlugRef.current
        if (requested) {
            requestedSlugRef.current = null
            consumeRequestedRef.current?.()
            const skill = list.find(s => s.slug === requested)
            if (skill) setView({ mode: 'edit', slug: skill.slug, readOnly: skill.fromConnector })
            else toast.error('Skill not found', { description: requested })
        }
        setLoading(false)
    }, [agentId])

    useEffect(() => {
        load()
    }, [load])

    // A proposal the user accepted lands in the background; the shelf picks the new skill up the
    // moment the row reports it applied, the same cue the web `/` menu listens for. The full row
    // set is watched (not just the pinned rows) so an applied row is still seen after its pin was
    // released.
    const appliedProposalRef = useRef<Set<string>>(new Set())
    const { proposals: allProposals, pinned: pinnedProposals, decide: decideProposal, pendingId, unavailable, refresh: refreshProposals } = useCoworkerSkillProposals(agentId)
    useEffect(() => {
        for (const proposal of allProposals.values()) {
            if (proposal.status === 'applied' && !appliedProposalRef.current.has(proposal.id)) {
                appliedProposalRef.current.add(proposal.id)
                load()
            }
        }
    }, [allProposals, load])

    const openProposalSkill = useCallback((slug: string) => {
        const skill = skills.find(s => s.slug === slug)
        setView({ mode: 'edit', slug, readOnly: skill?.fromConnector ?? false })
    }, [skills])

    const handleUploadFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (fileInputRef.current) fileInputRef.current.value = ''
        if (!file || importingRef.current || !mountedRef.current || isDesktopQuitting()) return
        setImportError(null)
        setImportNotice(null)
        if (file.size > MAX_SKILL_FILE_BYTES) {
            setImportError('File is too large (max 10 MB)')
            return
        }
        importingRef.current = true; setImporting(true)
        try {
            const content = await file.text()
            if (!mountedRef.current || isDesktopQuitting()) return
            const result = await importCoworkerSkill(agentId, content)
            if (!mountedRef.current || isDesktopQuitting()) return
            if (result.success) void load()
            else setImportError(result.error ?? 'Failed to import skill')
        } catch (error) { if (mountedRef.current) setImportError(error instanceof Error ? error.message : 'Failed to read skill') }
        finally { importingRef.current = false; if (mountedRef.current) setImporting(false) }
    }, [agentId, load])

    const handleUploadFolder = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? [])
        if (folderInputRef.current) folderInputRef.current.value = ''
        if (!files.length || importingRef.current || !mountedRef.current || isDesktopQuitting()) return
        setImportError(null)
        setImportNotice(null)
        importingRef.current = true; setImporting(true)
        try {
            const folders = await readSkillFolders(files)
            if (!mountedRef.current || isDesktopQuitting()) return
            const failures: string[] = []
            let imported = 0
            let skipped = 0
            for (const folder of folders) {
                if (!mountedRef.current || isDesktopQuitting()) return
                const result = await importCoworkerSkill(agentId, folder.content, folder.files)
                if (!mountedRef.current || isDesktopQuitting()) return
                if (result.success) {
                    imported += 1
                    skipped += folder.skipped.length
                } else {
                    failures.push(`${folder.name}: ${result.error ?? 'failed to import'}`)
                }
            }
            if (imported) {
                const notice = [`Imported ${imported} skill${imported === 1 ? '' : 's'}`]
                if (skipped) notice.push(`skipped ${skipped} non-text file${skipped === 1 ? '' : 's'}`)
                setImportNotice(notice.join(', '))
            }
            if (failures.length) setImportError(failures.join('\n'))
            load()
        } catch (err) {
            if (mountedRef.current) setImportError(err instanceof Error ? err.message : 'Failed to read the folder')
        } finally {
            importingRef.current = false; if (mountedRef.current) setImporting(false)
        }
    }, [agentId, load])

    const actionButtons = (
        <div className="flex items-center gap-1.5">
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" disabled={importing}>
                        {importing ? <Loader2Icon className="size-3.5 mr-1 animate-spin" /> : <UploadIcon className="size-3.5 mr-1" />} Upload
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem className="whitespace-nowrap" onSelect={() => fileInputRef.current?.click()}>
                        <FileTextIcon />
                        Markdown file
                    </DropdownMenuItem>
                    <DropdownMenuItem className="whitespace-nowrap" onSelect={() => folderInputRef.current?.click()}>
                        <FolderUpIcon />
                        Skill folder
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="outline" disabled={importing} onClick={() => setView({ mode: 'create' })}>
                <PlusIcon className="size-3.5 mr-1" /> New
            </Button>
        </div>
    )

    if (view.mode !== 'list') {
        return (
            <PanelSteps stepKey={view.mode === 'create' ? 'create' : `edit:${view.slug}`} depth={1}>
                <DesktopSkillEditor
                    key={view.mode === 'edit' ? view.slug : 'new'}
                    agentId={agentId}
                    slug={view.mode === 'edit' ? view.slug : undefined}
                    readOnly={view.mode === 'edit' ? view.readOnly : undefined}
                    onDone={() => { setView({ mode: 'list' }); load() }}
                    onBack={() => setView({ mode: 'list' })}
                />
            </PanelSteps>
        )
    }

    if (loading && !skills.length && !loadError) {
        return (
            <PanelSteps stepKey="list" depth={0}>
                <SkeletonPanelRows rows={5} badge />
            </PanelSteps>
        )
    }

    return (
        <PanelSteps stepKey="list" depth={0}>
            <div className="flex flex-col h-full">
                <input ref={fileInputRef} type="file" accept=".md,.markdown" className="hidden" onChange={handleUploadFile} />
                <input ref={folderInputRef} type="file" multiple className="hidden" onChange={handleUploadFolder} {...{ webkitdirectory: '' }} />
                <DesktopSkillProposalReview pinned={pinnedProposals} pendingId={pendingId} onDecide={decideProposal} onOpenSkill={openProposalSkill} />
                {unavailable && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Could not check all proposed changes. <Button size="sm" variant="link" onClick={() => void refreshProposals()}>Retry</Button></p>}
                {(!loadError || skills.length > 0) && <PanelListHeader count={skills.length} noun="skill">
                    {actionButtons}
                </PanelListHeader>}
                {loadError && <div role="alert" className="px-3 py-2 text-xs text-destructive border-b border-border">
                    <p>Could not load skills. {loadError}</p>
                    <Button size="sm" variant="outline" disabled={loading} loading={loading} onClick={() => void load()}>Retry loading skills</Button>
                </div>}
                {importError && <p className="px-3 py-2 text-xs text-destructive border-b border-border whitespace-pre-line">{importError}</p>}
                {importNotice && <p className="px-3 py-2 text-xs text-muted-foreground border-b border-border">{importNotice}</p>}

                {skills.length === 0 ? (!loadError && (
                    <EmptyState
                        icon={Layers}
                        title="No skills yet"
                        description="Skills are reusable step-by-step instructions your coworker learns, so it performs recurring tasks the same way every time."
                        action={actionButtons}
                    />
                )) : (
                    <PanelScroller>
                        <PanelList>
                            {skills.map(skill => (
                                <PanelRow
                                    key={skill.slug}
                                    onClick={() => setView({ mode: 'edit', slug: skill.slug, readOnly: skill.fromConnector })}
                                    title={skill.name}
                                    description={skill.description}
                                    meta={
                                        <>
                                            {skill.files.length > 0 && (
                                                <Badge size="xs" tone="neutral" glow={false} leading={<FileTextIcon className="size-2.5" />}>
                                                    {skill.files.length}
                                                </Badge>
                                            )}
                                            {skill.fromConnector && (
                                                <Badge size="xs" tone="neutral" glow={false} leading={<BlocksIcon className="size-2.5" />}>
                                                    App
                                                </Badge>
                                            )}
                                        </>
                                    }
                                />
                            ))}
                        </PanelList>
                    </PanelScroller>
                )}
            </div>
        </PanelSteps>
    )
}
