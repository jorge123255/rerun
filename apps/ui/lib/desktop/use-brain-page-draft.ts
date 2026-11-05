'use client'

import { brainMutationIntent, reserveBrainMutation, settleBrainMutation } from '@/components/desktop/brain/pages/mutation-intents'
import { readBrainUiState, writeBrainUiState, flushBrainUiState } from './brain-ui-state'
import { holdDraftAdmission, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
import type { BrainPageDetail, BrainWriteResult, DesktopBrainPagesActions } from '@/lib/desktop/brain-pages'
import { brainPageTypeSchema, type BrainPage } from '@rerun/contracts'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { z } from 'zod'

export type { BrainPageDetail }
export type BrainDraftWriteResult = BrainWriteResult
export type BrainDraftActions = Pick<DesktopBrainPagesActions, 'savePage' | 'readPage'>
export type BrainDraft = { title: string; type: BrainPage['type']; content: string }
export type BrainDraftWrite = BrainDraft & { sources: string[]; baseHash: string | null }
export type BrainDraftStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict'
const storedSchema = z.object({ draft: z.object({ title: z.string().max(120), type: brainPageTypeSchema, content: z.string().max(60_000) }),
    baseHash: z.string(), sources: z.array(z.string()), dirty: z.boolean(), conflicted: z.boolean(), error: z.string().nullable() })
type Entry = z.infer<typeof storedSchema> & {
    slug: string; status: BrainDraftStatus; conflictWith: BrainPage | null; revision: number; version: number;
    listeners: Set<() => void>; work?: Promise<void>; timer?: ReturnType<typeof setTimeout>;
    actions?: BrainDraftActions; onSaved?: (detail: BrainPageDetail) => void;
}
const drafts = new Map<string, Entry>()
const formFlushes = new Set<() => Promise<boolean>>()
export function registerBrainFormFlush(flush: () => Promise<boolean>) { formFlushes.add(flush); return () => { formFlushes.delete(flush) } }
let shutdownHooked = false
const valueOf = (page: BrainPage): BrainDraft => ({ title: page.title, type: page.type, content: page.content })

function publish(entry: Entry) {
    entry.version++
    for (const listener of entry.listeners) listener()
}
function remember(entry: Entry, confirmedDirty?: boolean): Promise<void> {
    const dirty = confirmedDirty ?? entry.dirty
    // A confirmed save snapshot is retained until its mutation intent is cleared. Otherwise
    // clean server-backed pages need no active draft record; their CAS tombstone is sufficient.
    const value = confirmedDirty !== undefined || dirty || entry.conflicted || entry.error
        ? { draft: entry.draft, baseHash: entry.baseHash, sources: entry.sources, dirty, conflicted: entry.conflicted, error: entry.error }
        : null
    return writeBrainUiState('draft:' + entry.slug, value)
}
function entryFor(page: BrainPage): Entry {
    let entry = drafts.get(page.slug)
    if (!entry) {
        const initial = { draft: valueOf(page), baseHash: page.hash, sources: page.sources, dirty: false, conflicted: false, error: null as string | null }
        try {
            const saved = typeof window === 'undefined' ? null : readBrainUiState('draft:' + page.slug)
            if (saved) {
                const parsed = storedSchema.parse(saved)
                if (parsed.dirty) Object.assign(initial, parsed)
            }
            const pending = brainMutationIntent('save:' + page.slug)
            if (pending?.input.kind === 'save') {
                if (!initial.dirty) initial.draft = { title: pending.input.input.title, type: pending.input.input.type, content: pending.input.input.content }
                initial.dirty = true
            }
        } catch { initial.error = 'Could not restore the saved Brain draft. Retry before editing this page.' }
        entry = { ...initial, slug: page.slug, status: initial.error ? 'error' : initial.conflicted ? 'conflict' : initial.dirty ? 'pending' : 'idle',
            conflictWith: null, revision: 0, version: 0, listeners: new Set() }
        drafts.set(page.slug, entry)
    } else if (!entry.dirty && !entry.work && entry.baseHash !== page.hash) {
        entry.draft = valueOf(page); entry.baseHash = page.hash; entry.sources = page.sources; entry.revision++; entry.version++
        entry.error = null; entry.status = 'idle'
    }
    return entry
}
export function brainDraftFor(page: BrainPage): BrainDraft { return entryFor(page).draft }
export function brainDraftHash(slug: string): string | undefined { return drafts.get(slug)?.baseHash }
export function brainDraftDirty(slug: string): boolean { return drafts.get(slug)?.dirty ?? false }
export function forgetBrainDraft(slug: string) {
    const entry = drafts.get(slug)
    if (entry?.work) throw new Error('Wait for this page to finish saving.')
    if (entry?.timer) clearTimeout(entry.timer)
    drafts.delete(slug)
    void writeBrainUiState('draft:' + slug, null).catch(() => {})
}
export async function flushDesktopBrainDrafts(): Promise<boolean> {
    await Promise.allSettled([...drafts.values()].map(entry => flushEntry(entry)))
    const forms = await Promise.allSettled([...formFlushes].map(flush => flush()))
    const persisted = await flushBrainUiState()
    return persisted && forms.every(result => result.status === 'fulfilled' && result.value) && ![...drafts.values()].some(entry => entry.dirty || entry.work)
}
function showError(entry: Entry, error: unknown) {
    entry.error = error instanceof Error ? error.message : 'Could not save this page. Try again.'
    entry.status = entry.conflicted ? 'conflict' : 'error'
    void remember(entry).catch(() => { /* The adapter retains the exact failed persistence attempt. */ })
    publish(entry)
}
async function flushEntry(entry: Entry): Promise<void> {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined }
    if (entry.work) return entry.work
    if (!entry.dirty || entry.conflicted || !entry.actions) return
    const work = (async () => {
        // Drain edits made during a successful save. Failures always stop and retain their input.
        while (entry.dirty && !entry.conflicted && entry.actions) {
            if (!entry.draft.title.trim()) { showError(entry, new Error('A page needs a title to be saved.')); return }
            const release = holdDraftAdmission()
            try {
                await remember(entry)
                const pending = await reserveBrainMutation('save:' + entry.slug, { kind: 'save', slug: entry.slug,
                    input: { ...entry.draft, sources: [...entry.sources], baseHash: entry.baseHash } })
                if (pending.input.kind !== 'save' || pending.input.slug !== entry.slug) throw new Error('The saved page request does not match this page.')
                entry.error = null; entry.status = 'saving'; publish(entry)
                let result: BrainWriteResult
                try { result = await entry.actions.savePage(entry.slug, pending.input.input, pending.requestId) }
                catch (error) { result = { ok: false, conflict: false, uncertain: true, error: error instanceof Error ? error.message : 'Could not save this page.' } }
                if (result.ok) {
                    entry.baseHash = result.detail.page.hash
                    entry.sources = result.detail.page.sources
                    const sent = pending.input.input
                    const newerDraft = () => entry.draft.title.trim() !== sent.title.trim() || entry.draft.type !== sent.type || entry.draft.content !== sent.content
                    entry.error = null
                    // Keep entry.dirty true, and the exact engine receipt identity, until the
                    // returned hash has reached app.db. A failed persistence write stays retryable.
                    await remember(entry, newerDraft())
                    await settleBrainMutation('save:' + entry.slug, result)
                    entry.dirty = newerDraft(); entry.status = entry.dirty ? 'pending' : 'saved'
                    await remember(entry); publish(entry); entry.onSaved?.(result.detail)
                } else {
                    await settleBrainMutation('save:' + entry.slug, result)
                    entry.error = result.error
                    if (result.conflict) {
                        entry.conflicted = true; entry.status = 'conflict'
                        try { entry.conflictWith = (await entry.actions.readPage(entry.slug))?.page ?? null }
                        catch { /* Keep the confirmed conflict; a failed read is never a missing page. */ }
                        await remember(entry); publish(entry)
                    } else showError(entry, new Error(result.error))
                    return
                }
            } catch (error) { showError(entry, error); return }
            finally { release() }
        }
    })()
    entry.work = work
    await work.finally(() => { if (entry.work === work) entry.work = undefined })
}
function schedule(entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => { void flushEntry(entry) }, 1000)
}

export function useBrainPageDraft({ page, actions, onSaved }: {
    page: BrainPage; actions: BrainDraftActions; onSaved: (detail: BrainPageDetail) => void;
}) {
    const entry = entryFor(page)
    entry.actions = actions; entry.onSaved = onSaved
    useSyncExternalStore(useCallback((listener: () => void) => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener) } }, [entry]),
        useCallback(() => entry.version, [entry]), () => 0)
    useEffect(() => {
        if (!shutdownHooked) { shutdownHooked = true; subscribeDraftShutdown(() => { void flushDesktopBrainDrafts() }) }
        if (entry.dirty && !entry.conflicted && !entry.error) schedule(entry)
        return () => { if (entry.timer) clearTimeout(entry.timer); if (entry.dirty && !entry.error) void flushEntry(entry) }
    }, [entry])
    const edit = useCallback((patch: Partial<BrainDraft>) => {
        entry.draft = { ...entry.draft, ...patch }; entry.dirty = true
        void remember(entry).catch(error => showError(entry, error))
        if (!entry.conflicted && !entry.error) { entry.status = 'pending'; schedule(entry) }
        publish(entry)
    }, [entry])
    const loadTheirs = useCallback(async (): Promise<BrainPage | null> => {
        if (entry.work) await entry.work
        try {
            if (brainMutationIntent('save:' + entry.slug)) throw new Error('Retry the pending save before choosing another version.')
            const latest = await actions.readPage(entry.slug)
            if (!latest) throw new Error('This page was deleted. Your draft is still saved here.')
            entry.draft = valueOf(latest.page); entry.baseHash = latest.page.hash; entry.sources = latest.page.sources
            entry.dirty = false; entry.conflicted = false; entry.conflictWith = null; entry.error = null; entry.status = 'idle'; entry.revision++
            await remember(entry); publish(entry); entry.onSaved?.(latest)
            return latest.page
        } catch (error) { showError(entry, error); return null }
    }, [entry, actions])
    const keepMine = useCallback(async () => {
        if (entry.work) await entry.work
        try {
            const latest = await actions.readPage(entry.slug)
            if (!latest) throw new Error('This page was deleted. Your draft is still saved here.')
            entry.baseHash = latest.page.hash; entry.sources = latest.page.sources; entry.conflicted = false; entry.conflictWith = null; entry.error = null
            await remember(entry); await flushEntry(entry)
        } catch (error) { showError(entry, error) }
    }, [entry, actions])
    return { status: entry.status, error: entry.error, conflictWith: entry.conflictWith, draft: entry.draft, revision: entry.revision,
        edit, flush: () => flushEntry(entry), loadTheirs, keepMine }
}
