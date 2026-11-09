'use client'

import { BrainEditor, type BrainEditorHandle } from '@/components/brain/editor/BrainEditor'
import { PageColumn, PageProperty, PageTitle, PageTypeIcon, PageTypeSelect } from '@/components/brain/BrainPageParts'
import type { SharedFileRef } from '@/components/brain/useSharedFilesTree'
import { Button } from '@/components/ui/button'
import { readBrainUiState, writeBrainUiState } from '@/lib/desktop/brain-ui-state'
import { registerBrainFormFlush } from '@/lib/desktop/use-brain-page-draft'
import { z } from 'zod'
import { brainPageTypeSchema } from '@rerun/contracts'
import { holdDraftAdmission } from '@/lib/desktop/draft-writes'
import { brainMutationIntent, reserveBrainMutation, settleBrainMutation } from './mutation-intents'
import { BrainTopBar } from '@/components/brain/BrainTopBar'
import { brainSlugify } from '@/lib/brain/labels'
import { BRAIN_PAGE_ICONS } from '@/lib/brain/page-icons'
import type { BrainDraftActions, BrainPageDetail } from '@/lib/desktop/use-brain-page-draft'
import type { BrainPageSummary, BrainPageType } from '@rerun/contracts'
import { useEffect, useRef, useState } from 'react'

type DesktopBrainNewPageProps = {
    pages: BrainPageSummary[]
    titles: Map<string, string>
    actions: BrainDraftActions
    files?: SharedFileRef[]
    onOpenPage: (slug: string) => void
    onOpenFile?: (path: string) => void
    onCreated: (detail: BrainPageDetail) => void
}

/**
 * The hosted new-page screen, unchanged in behavior: nothing is written while the title is empty,
 * the first blur with a title creates the page under the slug that title gives, and that slug stays
 * so the [[links]] other pages hold keep working.
 */
export function DesktopBrainNewPage({ pages, titles, actions, files = [], onOpenPage, onOpenFile, onCreated }: DesktopBrainNewPageProps) {
    const [pendingCreate, setPendingCreate] = useState(() => { try { return brainMutationIntent('create') } catch { return null } })
    const [formSaved] = useState(() => {
        try {
            const saved = readBrainUiState('new-page')
            return { value: saved === null ? null : z.object({ title: z.string().max(120), type: brainPageTypeSchema, content: z.string().max(60_000) }).strict().parse(saved), error: null }
        } catch { return { value: null, error: 'The saved new page could not be read. It has been left unchanged.' } }
    })
    const restored = pendingCreate?.input.kind === 'save' ? pendingCreate.input.input : formSaved.value
    const [title, setTitle] = useState(restored?.title ?? '')
    const [type, setType] = useState<BrainPageType>(restored?.type ?? 'note')
    const [error, setError] = useState<string | null>(formSaved.error)
    const [creating, setCreating] = useState(false)
    const content = useRef(restored?.content ?? '')
    // Enter commits the title, then moves the focus to the body, which blurs the title and commits
    // it a second time in the same tick: the state alone would not see the first one yet.
    const started = useRef(false)
    const editorHandle = useRef<BrainEditorHandle>(null)
    const form = useRef({ title, type, content: content.current })
    form.current = { title, type, content: content.current }
    const completed = useRef(false)
    const persistForm = async () => {
        if (completed.current) return true
        if (formSaved.error) return false
        try { await writeBrainUiState('new-page', { ...form.current }); return true }
        catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this new-page draft.'); return false }
    }
    useEffect(() => registerBrainFormFlush(persistForm))
    const saveFormEdit = (patch: Partial<typeof form.current>) => {
        form.current = { ...form.current, ...patch }
        void persistForm()
    }

    const create = async () => {
        const trimmed = title.trim()
        if (!trimmed || started.current || formSaved.error) return
        const slug = brainSlugify(trimmed)
        if (!slug) {
            setError('Use at least one letter or digit in the title.')
            return
        }
        if (!pendingCreate && titles.has(slug)) {
            setError(`A page "${titles.get(slug)}" already exists. Pick another title.`)
            return
        }
        started.current = true
        setCreating(true)
        const release = holdDraftAdmission()
        try {
            if (!await persistForm()) throw new Error('Save this new-page draft before creating it.')
            const pending = await reserveBrainMutation('create', { kind: 'save', slug, input: { title: trimmed, type, content: content.current, sources: [], baseHash: null } })
            if (pending.input.kind !== 'save') throw new Error('The saved create request could not be read.')
            setPendingCreate(pending)
            const result = await actions.savePage(pending.input.slug, pending.input.input, pending.requestId)
            if (result.ok) { await writeBrainUiState('new-page', null); completed.current = true }
            await settleBrainMutation('create', result)
            if (result.ok || !result.uncertain) setPendingCreate(null)
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
            release()
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
                        readOnly={creating || !!pendingCreate || !!formSaved.error}
                        onChange={next => {
                            setTitle(next)
                            saveFormEdit({ title: next })
                            setError(null)
                        }}
                        onCommit={() => void create()}
                        onEnter={() => editorHandle.current?.focus('start')}
                    />
                    {pendingCreate && !error && <div role="status" className="mt-1 text-xs">This page has an unfinished save.
                        <Button size="xs" disabled={creating} onClick={() => void create()}>Retry save</Button></div>}
                    {error ? (
                        <div role="alert" className="mt-1 text-xs text-destructive">{error}<Button size="xs" variant="outline" disabled={creating} onClick={() => void create()}>Try again</Button></div>
                    ) : (
                        title.trim() && <p className="mt-1 text-xs text-muted-foreground">Coworkers link to it as [[{brainSlugify(title)}]]</p>
                    )}

                    <div className="mt-4 space-y-0.5 border-b border-border pb-4">
                        <PageProperty label="Type">
                            <PageTypeSelect value={type} onChange={next => { setType(next); saveFormEdit({ type: next }) }} disabled={creating || !!pendingCreate || !!formSaved.error} />
                        </PageProperty>
                    </div>

                    <BrainEditor
                        className="mt-6"
                        content={content.current}
                        editable={!creating && !pendingCreate && !formSaved.error}
                        pages={pages}
                        titles={titles}
                        files={files}
                        handleRef={editorHandle}
                        placeholder="Give the page a title, then type / for commands"
                        onOpenPage={onOpenPage}
                        onOpenFile={onOpenFile}
                        onChange={markdown => { content.current = markdown; saveFormEdit({ content: markdown }) }}
                        onBlur={() => void create()}
                    />
                </PageColumn>
            </div>
        </div>
    )
}
