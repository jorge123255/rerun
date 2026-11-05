'use client'

import { BrainEditor, type BrainEditorHandle } from '@/components/brain/editor/BrainEditor'
import { PageColumn, PageProperty, PageTitle, PageTypeIcon, PageTypeSelect } from '@/components/brain/BrainPageParts'
import { BrainTopBar } from '@/components/brain/BrainTopBar'
import { brainSlugify } from '@/lib/brain/labels'
import { BRAIN_PAGE_ICONS } from '@/lib/brain/page-icons'
import type { BrainDraftActions, BrainPageDetail } from '@/lib/desktop/use-brain-page-draft'
import type { BrainPageSummary, BrainPageType } from '@rerun/contracts'
import { useRef, useState } from 'react'

type DesktopBrainNewPageProps = {
    pages: BrainPageSummary[]
    titles: Map<string, string>
    actions: BrainDraftActions
    onOpenPage: (slug: string) => void
    onCreated: (detail: BrainPageDetail) => void
}

/**
 * The hosted new-page screen, unchanged in behavior: nothing is written while the title is empty,
 * the first blur with a title creates the page under the slug that title gives, and that slug stays
 * so the [[links]] other pages hold keep working.
 */
export function DesktopBrainNewPage({ pages, titles, actions, onOpenPage, onCreated }: DesktopBrainNewPageProps) {
    const [title, setTitle] = useState('')
    const [type, setType] = useState<BrainPageType>('note')
    const [error, setError] = useState<string | null>(null)
    const [creating, setCreating] = useState(false)
    const content = useRef('')
    // Enter commits the title, then moves the focus to the body, which blurs the title and commits
    // it a second time in the same tick: the state alone would not see the first one yet.
    const started = useRef(false)
    const editorHandle = useRef<BrainEditorHandle>(null)

    const create = async () => {
        const trimmed = title.trim()
        if (!trimmed || started.current) return
        const slug = brainSlugify(trimmed)
        if (!slug) {
            setError('Use at least one letter or digit in the title.')
            return
        }
        if (titles.has(slug)) {
            setError(`A page "${titles.get(slug)}" already exists. Pick another title.`)
            return
        }
        started.current = true
        setCreating(true)
        try {
            const result = await actions.savePage(slug, { title: trimmed, type, content: content.current, sources: [], baseHash: null })
            if (!result.ok) {
                started.current = false
                setError(result.error)
                return
            }
            onCreated(result.detail)
        } catch (cause) {
            started.current = false
            setError(cause instanceof Error && cause.message ? cause.message : 'Could not create this page. Try again.')
        } finally {
            setCreating(false)
        }
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <BrainTopBar crumbs={[{ label: 'Pages' }, { label: title.trim() || 'New page', icon: BRAIN_PAGE_ICONS[type] }]} status={creating ? 'Saving…' : null} />
            <div className="min-h-0 flex-1 overflow-y-auto">
                <PageColumn>
                    <PageTypeIcon type={type} />
                    <PageTitle
                        value={title}
                        autoFocus
                        onChange={next => {
                            setTitle(next)
                            setError(null)
                        }}
                        onCommit={() => void create()}
                        onEnter={() => editorHandle.current?.focus('start')}
                    />
                    {error ? (
                        <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>
                    ) : (
                        title.trim() && <p className="mt-1 text-xs text-muted-foreground">Coworkers link to it as [[{brainSlugify(title)}]]</p>
                    )}

                    <div className="mt-4 space-y-0.5 border-b border-border pb-4">
                        <PageProperty label="Type">
                            <PageTypeSelect value={type} onChange={setType} />
                        </PageProperty>
                    </div>

                    <BrainEditor
                        className="mt-6"
                        content=""
                        pages={pages}
                        titles={titles}
                        handleRef={editorHandle}
                        placeholder="Give the page a title, then type / for commands"
                        onOpenPage={onOpenPage}
                        onChange={markdown => (content.current = markdown)}
                        onBlur={() => void create()}
                    />
                </PageColumn>
            </div>
        </div>
    )
}
