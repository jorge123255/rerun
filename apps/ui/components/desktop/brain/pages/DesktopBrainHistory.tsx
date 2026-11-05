'use client'

import { BrainEditor } from '@/components/brain/editor/BrainEditor'
import { PageColumn } from '@/components/brain/BrainPageParts'
import { BrainTopBar } from '@/components/brain/BrainTopBar'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { brainAuthorLabel, isCardType } from '@/lib/brain/labels'
import { BRAIN_PAGE_ICONS } from '@/lib/brain/page-icons'
import type { BrainPageDetail } from '@/lib/desktop/use-brain-page-draft'
import { ArrowLeftIcon } from '@/lib/icons'
import { fullDateTime, shortRelativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { BrainPage, BrainRevision } from '@rerun/contracts'
import { useEffect, useState } from 'react'
import type { DesktopBrainActions } from './types'

type DesktopBrainHistoryProps = {
    page: BrainPage
    revisions: BrainRevision[]
    titles: Map<string, string>
    actions: Pick<DesktopBrainActions, 'readRevision' | 'restoreRevision'>
    onBack: () => void
    onOpenPage: (slug: string) => void
    onRestored: (detail: BrainPageDetail) => void
}

function PreviewSkeleton() {
    return (
        <PageColumn>
            <Skeleton className="h-8 w-1/2" />
            <div className="mt-8 space-y-3">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-2/3" />
            </div>
        </PageColumn>
    )
}

/**
 * The hosted version history, unchanged in layout: what the page said on the left, who changed it
 * and when on the right. Restore asks first, and a refused restore is reported instead of closing
 * on a version that was not written.
 */
export function DesktopBrainHistory({ page, revisions, titles, actions, onBack, onOpenPage, onRestored }: DesktopBrainHistoryProps) {
    const [selectedId, setSelectedId] = useState<string | null>(revisions[0]?.id ?? null)
    const [preview, setPreview] = useState<{ id: string; content: string } | null>(null)
    const [previewError, setPreviewError] = useState<string | null>(null)
    const [restoring, setRestoring] = useState(false)
    const [restoreError, setRestoreError] = useState<string | null>(null)

    const selected = revisions.find(revision => revision.id === selectedId) ?? null
    const isCurrent = selected !== null && selected.id === revisions[0]?.id && selected.hash === page.hash

    useEffect(() => {
        if (!selectedId) return
        let cancelled = false
        setPreviewError(null)
        actions.readRevision(page.slug, selectedId)
            .then(found => {
                if (cancelled) return
                if (!found) { setPreviewError('That version is no longer available.'); return }
                setPreview({ id: selectedId, content: found.content })
            })
            .catch(cause => {
                if (cancelled) return
                setPreviewError(cause instanceof Error && cause.message ? cause.message : 'Could not read that version.')
            })
        return () => { cancelled = true }
    }, [actions, page.slug, selectedId])

    // Escape steps back to the page rather than closing the whole panel.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || document.querySelector('[role="alertdialog"]')) return
            event.preventDefault()
            onBack()
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
    }, [onBack])

    const restore = async () => {
        if (!selected) return
        setRestoring(true)
        setRestoreError(null)
        try {
            const result = await actions.restoreRevision(page.slug, selected.id, page.hash)
            if (!result.ok) { setRestoreError(result.error); return }
            onRestored(result.detail)
        } catch (cause) {
            setRestoreError(cause instanceof Error && cause.message ? cause.message : 'Could not restore that version.')
        } finally {
            setRestoring(false)
        }
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <BrainTopBar crumbs={[{ label: isCardType(page.type) ? 'Company' : 'Pages' }, { label: page.title, icon: BRAIN_PAGE_ICONS[page.type], onClick: onBack }, { label: 'Version history' }]}>
                <Button size="sm" variant="ghost" onClick={onBack}>
                    <ArrowLeftIcon /> Back to page
                </Button>
            </BrainTopBar>

            <div className="flex min-h-0 flex-1 border-t border-border max-sm:flex-col-reverse">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    {selected && (
                        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm">
                            <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                {isCurrent ? 'Current version' : `Version from ${fullDateTime(selected.createdAt)}`}
                            </span>
                            {!isCurrent && (
                                <ConfirmDialog
                                    title="Restore this version?"
                                    description="The page goes back to what it said then. The current version stays in the history."
                                    confirmLabel="Restore"
                                    confirmVariant="default"
                                    pending={restoring}
                                    onConfirm={() => void restore()}
                                >
                                    <Button size="xs">Restore this version</Button>
                                </ConfirmDialog>
                            )}
                        </div>
                    )}
                    {restoreError && <p role="alert" className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">{restoreError}</p>}
                    {previewError && <p role="alert" className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">{previewError}</p>}
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {!selected ? (
                            <p className="p-6 text-sm text-muted-foreground">No version recorded for this page yet.</p>
                        ) : preview?.id !== selected.id ? (
                            <PreviewSkeleton />
                        ) : (
                            <PageColumn>
                                <h1 className="text-[2rem] font-semibold leading-tight tracking-tight">{selected.title}</h1>
                                <BrainEditor key={selected.id} className="mt-6" content={preview.content} editable={false} titles={titles} onOpenPage={onOpenPage} />
                            </PageColumn>
                        )}
                    </div>
                </div>

                <aside className="flex min-h-0 shrink-0 flex-col border-border sm:w-64 sm:border-l max-sm:max-h-48 max-sm:border-b">
                    <p className="px-4 pb-1 pt-3 text-[11px] font-medium text-muted-foreground/80">Versions</p>
                    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                        {revisions.map((revision, index) => (
                            <button
                                key={revision.id}
                                type="button"
                                onClick={() => setSelectedId(revision.id)}
                                className={cn('block w-full rounded-md px-2 py-1.5 text-left transition-colors', revision.id === selectedId ? 'bg-accent' : 'hover:bg-accent/60')}
                            >
                                <span className="block text-sm font-medium" title={fullDateTime(revision.createdAt)}>
                                    {index === 0 && revision.hash === page.hash ? 'Current' : shortRelativeTime(revision.createdAt)}
                                </span>
                                <span className="block truncate text-xs text-muted-foreground">
                                    {brainAuthorLabel(revision.author)}
                                    {revision.proposalId ? ' · From a proposal' : ''}
                                </span>
                            </button>
                        ))}
                    </div>
                </aside>
            </div>
        </div>
    )
}
