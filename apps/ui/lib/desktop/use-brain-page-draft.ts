'use client'

import { holdDraftAdmission, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
import type { BrainPage, BrainPageType, BrainRevision } from '@rerun/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'

/** One page as the editor reads and writes it: the contract shapes the engine already speaks. */
export type BrainPageDetail = { page: BrainPage; revisions: BrainRevision[] }

export type BrainDraft = { title: string; type: BrainPageType; content: string }

export type BrainDraftWrite = BrainDraft & { sources: string[]; baseHash: string | null }

export type BrainDraftWriteResult = { ok: true; detail: BrainPageDetail } | { ok: false; conflict: boolean; error: string }

/**
 * The only two actions autosave needs. The panel's full actions interface extends this, so a page
 * editor can be dropped on any implementation that answers like the original brain actions.
 */
export type BrainDraftActions = {
    savePage: (slug: string, write: BrainDraftWrite) => Promise<BrainDraftWriteResult>
    readPage: (slug: string) => Promise<BrainPageDetail | null>
}

export type BrainDraftStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict'

const DEBOUNCE_MS = 1000

type Cached = { draft: BrainDraft; baseHash: string | null; dirty: boolean; error: string | null }

// The draft outlives the component: switching page, opening the history, or closing and reopening
// the panel brings back exactly what was typed, not what was last saved. Keyed by slug because a
// slug is stable for the life of a page.
const drafts = new Map<string, Cached>()

// Every mounted editor's flush, so closing the dialog or quitting the app can wait for real writes
// instead of dropping a keystroke.
const flushes = new Map<string, () => Promise<void>>()
let shutdownHooked = false

function hookShutdown() {
    if (shutdownHooked) return
    shutdownHooked = true
    subscribeDraftShutdown(() => { void flushDesktopBrainDrafts() })
}

/** What the editor should open on for this slug, saved or not. */
export function brainDraftFor(page: BrainPage): BrainDraft {
    return drafts.get(page.slug)?.draft ?? { title: page.title, type: page.type, content: page.content }
}

/** True while a page holds an edit that has not reached the engine. */
export function brainDraftDirty(slug: string): boolean {
    return drafts.get(slug)?.dirty ?? false
}

/** Every unsaved brain draft, flushed. Returns false when one still cannot be written. */
export async function flushDesktopBrainDrafts(): Promise<boolean> {
    const pending = [...flushes.values()]
    if (!pending.length) return ![...drafts.values()].some(entry => entry.dirty)
    await Promise.allSettled(pending.map(flush => flush()))
    return ![...drafts.values()].some(entry => entry.dirty)
}

/** Drops a page's unsaved draft, after it was deleted or when the person picked the other version. */
export function forgetBrainDraft(slug: string) {
    drafts.delete(slug)
}

/**
 * The original autosave, on injected actions instead of server actions. A page saves itself a
 * second after the last keystroke, against the version it was opened at; a change that landed in
 * between refuses the write and the person picks a side, with nothing lost either way.
 *
 * A failure is never reported as a save: the draft stays dirty, the error stays on screen, and the
 * next flush retries the same text.
 */
export function useBrainPageDraft({ page, actions, onSaved }: {
    page: BrainPage
    actions: BrainDraftActions
    onSaved: (detail: BrainPageDetail) => void
}) {
    const cached = drafts.get(page.slug)
    const [status, setStatus] = useState<BrainDraftStatus>(cached?.error ? 'error' : cached?.dirty ? 'pending' : 'idle')
    const [error, setError] = useState<string | null>(cached?.error ?? null)
    const [conflictWith, setConflictWith] = useState<BrainPage | null>(null)
    const [revision, setRevision] = useState(0)

    const draft = useRef<BrainDraft>(cached?.draft ?? { title: page.title, type: page.type, content: page.content })
    const baseHash = useRef<string | null>(cached?.baseHash ?? page.hash)
    const sources = useRef(page.sources)
    const dirty = useRef(cached?.dirty ?? false)
    const conflicted = useRef(false)
    const failed = useRef(Boolean(cached?.error))
    const inFlight = useRef<Promise<void> | null>(null)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const admission = useRef<(() => void) | null>(null)
    const onSavedRef = useRef(onSaved)
    const actionsRef = useRef(actions)
    const slug = page.slug

    useEffect(() => { onSavedRef.current = onSaved })
    useEffect(() => { actionsRef.current = actions })

    const errorRef = useRef<string | null>(cached?.error ?? null)

    const remember = useCallback(() => {
        drafts.set(slug, { draft: draft.current, baseHash: baseHash.current, dirty: dirty.current, error: failed.current ? errorRef.current : null })
    }, [slug])

    const write = useCallback(async () => {
        if (!dirty.current || conflicted.current) return
        if (!draft.current.title.trim()) return
        dirty.current = false
        failed.current = false
        errorRef.current = null
        setStatus('saving')
        admission.current ??= holdDraftAdmission()
        const snapshot = draft.current
        let result: BrainDraftWriteResult
        try {
            result = await actionsRef.current.savePage(slug, { ...snapshot, sources: sources.current, baseHash: baseHash.current })
        } catch (cause) {
            result = { ok: false, conflict: false, error: cause instanceof Error && cause.message ? cause.message : 'Could not save this page. Try again.' }
        }
        if (result.ok) {
            baseHash.current = result.detail.page.hash
            sources.current = result.detail.page.sources
            errorRef.current = null
            setError(null)
            setStatus(dirty.current ? 'pending' : 'saved')
            onSavedRef.current(result.detail)
            remember()
            if (!dirty.current) { admission.current?.(); admission.current = null }
            return
        }
        dirty.current = true
        if (result.conflict) {
            conflicted.current = true
            setStatus('conflict')
            const latest = await actionsRef.current.readPage(slug).catch(() => null)
            setConflictWith(latest?.page ?? null)
            remember()
            admission.current?.()
            admission.current = null
            return
        }
        failed.current = true
        errorRef.current = result.error
        setError(result.error)
        setStatus('error')
        remember()
        admission.current?.()
        admission.current = null
    }, [slug, remember])

    const schedule = useCallback(() => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => { void flushRef.current() }, DEBOUNCE_MS)
    }, [])

    const flushRef = useRef<() => Promise<void>>(async () => {})
    const flush = useCallback(async () => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null }
        while (inFlight.current) await inFlight.current
        if (!dirty.current || conflicted.current) return
        const run = write().finally(() => { inFlight.current = null })
        inFlight.current = run
        await run
        if (dirty.current && !conflicted.current && !failed.current && draft.current.title.trim()) schedule()
    }, [write, schedule])

    useEffect(() => { flushRef.current = flush })

    const edit = useCallback((patch: Partial<BrainDraft>) => {
        draft.current = { ...draft.current, ...patch }
        dirty.current = true
        remember()
        if (!conflicted.current) {
            setStatus('pending')
            schedule()
        }
    }, [schedule, remember])

    // Their version replaces the draft and the editor remounts on it.
    const loadTheirs = useCallback(async (): Promise<BrainPage | null> => {
        const latest = await actionsRef.current.readPage(slug).catch(() => null)
        if (!latest) return null
        draft.current = { title: latest.page.title, type: latest.page.type, content: latest.page.content }
        baseHash.current = latest.page.hash
        sources.current = latest.page.sources
        dirty.current = false
        conflicted.current = false
        failed.current = false
        errorRef.current = null
        setConflictWith(null)
        setError(null)
        setStatus('idle')
        setRevision(current => current + 1)
        onSavedRef.current(latest)
        remember()
        return latest.page
    }, [slug, remember])

    // This draft wins, written on top of the version that refused it.
    const keepMine = useCallback(async () => {
        const latest = await actionsRef.current.readPage(slug).catch(() => null)
        baseHash.current = latest?.page.hash ?? null
        if (latest) sources.current = latest.page.sources
        conflicted.current = false
        setConflictWith(null)
        dirty.current = true
        remember()
        await flush()
    }, [slug, flush, remember])

    // A draft left dirty by an earlier mount (a close during a failed save) is retried on return.
    useEffect(() => {
        if (dirty.current && !conflicted.current && !failed.current) schedule()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        hookShutdown()
        flushes.set(slug, flush)
        return () => {
            if (flushes.get(slug) === flush) flushes.delete(slug)
        }
    }, [slug, flush])

    // Leaving the page, closing the dialog or switching page never drops a keystroke: the write
    // starts now and the cache keeps the text until it lands.
    useEffect(() => () => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null }
        if (!inFlight.current && !(dirty.current && !conflicted.current)) return
        if (inFlight.current) void inFlight.current.then(() => (dirty.current && !conflicted.current ? write() : undefined))
        else void write()
    }, [write])

    return { status, error, conflictWith, draft: draft.current, revision, edit, flush, loadTheirs, keepMine }
}
