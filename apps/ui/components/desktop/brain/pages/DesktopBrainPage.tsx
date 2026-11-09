'use client'

import { BrainEditor, type BrainEditorHandle } from '@/components/brain/editor/BrainEditor'
import { PageColumn, PageProperty, PageTitle, PageTypeIcon, PageTypeSelect, UnconfirmedSections } from '@/components/brain/BrainPageParts'
import { BrainTopBar } from '@/components/brain/BrainTopBar'
import type { SharedFileRef } from '@/components/brain/useSharedFilesTree'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { brainAuthorLabel, brainSourceLabels, isCardType } from '@/lib/brain/labels'
import { BRAIN_PAGE_ICONS } from '@/lib/brain/page-icons'
import { brainDraftFor, brainDraftHash, flushDesktopBrainDrafts, useBrainPageDraft, type BrainDraftStatus, type BrainPageDetail } from '@/lib/desktop/use-brain-page-draft'
import { ChevronRightIcon, CopyIcon, EllipsisIcon, HistoryIcon, Trash2Icon } from '@/lib/icons'
import { shortRelativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { BrainPageSummary, BrainPageType, BrainPage as BrainPageData } from '@rerun/contracts'
import { Badge } from '@rerun/ui/primitives'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import type { DesktopBrainActions } from './types'
import { brainMutationIntent, reserveBrainMutation, settleBrainMutation } from './mutation-intents'

type DesktopBrainPageProps = {
    detail: BrainPageDetail
    pages: BrainPageSummary[]
    titles: Map<string, string>
    actions: DesktopBrainActions
    files?: SharedFileRef[]
    onOpenPage: (slug: string) => void
    onOpenFile?: (path: string) => void
    onAcceptFileDrop?: (raw: string) => SharedFileRef | null
    onSaved: (detail: BrainPageDetail) => void
    onHistory: () => void
    onDeleted: (slug: string) => Promise<void> | void
}

function saveLabel(status: BrainDraftStatus, page: BrainPageData): string | null {
    if (status === 'pending' || status === 'saving') return 'Saving…'
    if (status === 'saved') return 'Saved'
    if (status === 'error') return 'Not saved'
    if (status === 'conflict') return null
    return page.updatedAt ? `Edited ${shortRelativeTime(page.updatedAt)}` : null
}

function Backlinks({ links, onOpenPage }: { links: BrainPageData['backlinks']; onOpenPage: (slug: string) => void }) {
    const [open, setOpen] = useState(false)
    if (links.length === 0) return null
    return (
        <div className="mt-12 border-t border-border pt-4">
            <button type="button" onClick={() => setOpen(value => !value)} className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground" aria-expanded={open}>
                <ChevronRightIcon className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')} />
                {links.length} {links.length === 1 ? 'page links here' : 'pages link here'}
            </button>
            {open && (
                <div className="mt-2 space-y-0.5">
                    {links.map(link => (
                        <button key={link.slug} type="button" onClick={() => onOpenPage(link.slug)} className="block w-full rounded-md px-2 py-1 text-left text-sm underline decoration-foreground/30 underline-offset-2 transition-colors hover:bg-accent hover:decoration-foreground">
                            {link.title}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

/**
 * The hosted page editor, on injected actions: the title, the type and the body are typed in place
 * and saved as they change. Nothing about the layout is new; what changes is that the writes go to
 * whatever store root injected, and a refused or failed write is shown as such.
 *
 */
export function DesktopBrainPage({ detail, pages, titles, actions, files = [], onOpenPage, onOpenFile, onAcceptFileDrop, onSaved, onHistory, onDeleted }: DesktopBrainPageProps) {
    const page = detail.page
    const initial = brainDraftFor(page)
    const autosave = useBrainPageDraft({ page, actions, onSaved })
    const [title, setTitle] = useState(initial.title)
    const [type, setType] = useState<BrainPageType>(initial.type)
    const [content, setContent] = useState(initial.content)
    const [editorKey, setEditorKey] = useState(0)
    const [confirmingDelete, setConfirmingDelete] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const editorHandle = useRef<BrainEditorHandle>(null)
    const [confirming, setConfirming] = useState(false)
    const [confirmError, setConfirmError] = useState<string | null>(null)
    let pendingDelete = false
    try { pendingDelete = !!brainMutationIntent('delete:' + page.slug) } catch { pendingDelete = true }
    const confirmSections = async () => {
        setConfirming(true); setConfirmError(null)
        try {
            if (!await flushDesktopBrainDrafts()) throw new Error('Save or resolve your page edits before confirming sections.')
            const pending = await reserveBrainMutation('confirm:' + page.slug, { kind: 'confirm', slug: page.slug,
                headings: [...page.unconfirmed], expectedHash: brainDraftHash(page.slug) ?? page.hash })
            if (pending.input.kind !== 'confirm' || pending.input.slug !== page.slug) throw new Error('The saved confirmation does not match this page.')
            const result = await actions.confirmSections(page.slug, pending.input.headings, pending.input.expectedHash, pending.requestId)
            await settleBrainMutation('confirm:' + page.slug, result)
            if (!result.ok) throw new Error(result.error)
            onSaved(result.detail)
        } catch (error) { setConfirmError(error instanceof Error ? error.message : 'Could not confirm these sections. Try again.') }
        finally { setConfirming(false) }
    }

    const loadTheirs = async () => {
        const latest = await autosave.loadTheirs()
        if (!latest) return
        setTitle(latest.title)
        setType(latest.type)
        setContent(latest.content)
        setEditorKey(key => key + 1)
    }

    const remove = async () => {
        setDeleting(true)
        try { await onDeleted(page.slug) } finally { setDeleting(false); setConfirmingDelete(false) }
    }

    const section = isCardType(type) ? 'Company' : 'Pages'
    const status = saveLabel(autosave.status, page)

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <BrainTopBar
                crumbs={[{ label: section }, { label: title.trim() || 'Untitled', icon: BRAIN_PAGE_ICONS[type] }]}
                status={status && <span className={cn(autosave.status === 'error' && 'text-destructive')} title={autosave.error ?? undefined}>{status}</span>}
            >
                <Button size="icon-sm" variant="ghost" onClick={onHistory} aria-label="Version history" title="Version history">
                    <HistoryIcon />
                </Button>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label="More" title="More">
                            <EllipsisIcon />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem
                            onSelect={() => {
                                void navigator.clipboard.writeText(`[[${page.slug}]]`)
                                toast.success('Link copied', { description: `Paste [[${page.slug}]] in another page.` })
                            }}
                        >
                            <CopyIcon /> Copy link
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={onHistory}>
                            <HistoryIcon /> Version history
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingDelete(true)}>
                            <Trash2Icon /> Delete
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </BrainTopBar>

            {autosave.status === 'conflict' && (
                <div className="flex flex-wrap items-center gap-2 border-y border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm">
                    <span className="min-w-0 flex-1">
                        <span className="font-medium">{autosave.conflictWith ? brainAuthorLabel(autosave.conflictWith.updatedBy) : 'Someone'}</span> changed this page while you were editing.
                    </span>
                    <Button size="xs" variant="outline" onClick={() => void loadTheirs()}>
                        Load their version
                    </Button>
                    <Button size="xs" onClick={() => void autosave.keepMine()}>
                        Keep mine
                    </Button>
                </div>
            )}

            {(autosave.status === 'error' || autosave.status === 'conflict') && autosave.error && (
                <div role="alert" className="flex flex-wrap items-center gap-2 border-y border-destructive/30 bg-destructive/10 px-4 py-2 text-sm">
                    <span className="min-w-0 flex-1">{autosave.error}</span>
                    <Button size="xs" variant="outline" onClick={() => void autosave.flush()}>
                        Try again
                    </Button>
                </div>
            )}

            {pendingDelete && <div role="alert" className="px-4 py-2 text-sm">The delete request has not been confirmed. Retry it before editing.
                <Button size="xs" disabled={deleting} onClick={() => void remove()}>Retry delete</Button></div>}
            <div className="min-h-0 flex-1 overflow-y-auto">
                <PageColumn>
                    <PageTypeIcon type={type} />
                    <PageTitle
                        value={title}
                        readOnly={deleting || pendingDelete}
                        onChange={next => {
                            setTitle(next)
                            autosave.edit({ title: next })
                        }}
                        onEnter={() => editorHandle.current?.focus('start')}
                    />
                    {!title.trim() && <p className="mt-1 text-xs text-muted-foreground">A page needs a title to be saved.</p>}

                    <div className="mt-4 space-y-0.5 border-b border-border pb-4">
                        <PageProperty label="Type">
                            <PageTypeSelect
                                value={type}
                                disabled={deleting || pendingDelete}
                                onChange={next => {
                                    setType(next)
                                    autosave.edit({ type: next })
                                }}
                            />
                        </PageProperty>
                        {page.sources.length > 0 && (
                            <PageProperty label="Sources">
                                {brainSourceLabels(page.sources).map(source => (
                                    <Badge key={source} size="xs" tone="neutral" glow={false} fill="outline">
                                        {source}
                                    </Badge>
                                ))}
                            </PageProperty>
                        )}
                        {page.unconfirmed.length > 0 && <UnconfirmedSections headings={page.unconfirmed} confirming={confirming}
                            onConfirm={() => void confirmSections()} />}
                        {confirmError && <p role="alert" className="text-xs text-destructive">{confirmError}<Button size="xs" variant="outline" disabled={confirming} onClick={() => void confirmSections()}>Try again</Button></p>}
                        {page.updatedAt && (
                            <PageProperty label="Last edited">
                                <span className="text-foreground/80">
                                    {shortRelativeTime(page.updatedAt)} by {brainAuthorLabel(page.updatedBy)}
                                </span>
                            </PageProperty>
                        )}
                    </div>

                    <BrainEditor
                        key={editorKey}
                        editable={!deleting && !pendingDelete}
                        className="mt-6"
                        content={content}
                        pages={pages}
                        titles={titles}
                        files={files}
                        currentSlug={page.slug}
                        handleRef={editorHandle}
                        onOpenPage={onOpenPage}
                        onOpenFile={onOpenFile}
                        onAcceptFileDrop={onAcceptFileDrop}
                        onChange={markdown => {
                            setContent(markdown)
                            autosave.edit({ content: markdown })
                        }}
                        onBlur={() => void autosave.flush()}
                    />

                    <Backlinks links={page.backlinks} onOpenPage={onOpenPage} />
                </PageColumn>
            </div>

            <ConfirmDialog
                open={confirmingDelete}
                onOpenChange={setConfirmingDelete}
                pending={deleting}
                title={`Delete "${page.title}"?`}
                description="Coworkers stop reading it and other pages linking to it lose the link."
                onConfirm={() => void remove()}
            />
        </div>
    )
}
