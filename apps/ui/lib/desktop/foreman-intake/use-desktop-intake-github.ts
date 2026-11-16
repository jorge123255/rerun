'use client'

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import {
    applyGithubProjectsEdit,
    desktopGithubProjectsRecordSchema,
    githubRepositoryLinksMessage,
    parseGithubRepositoryLinks,
    type DesktopForemanChatRef,
    type DesktopGithubProjectsEdit,
    type DesktopGithubProjectsRecord,
} from '@rerun/contracts'

/**
 * The owner's GitHub projects in the first intake step: the field, the read and the review share
 * this one state per conversation, so the field in the questions and the cards over the board
 * always show the same thing. The saved reading lives on this Mac's server side; this only mirrors it.
 */

export type DesktopIntakeGithubAnswer = { record: DesktopGithubProjectsRecord | null; message: string | null }
export type DesktopIntakeGithubPorts = {
    read(chat: DesktopForemanChatRef, signal?: AbortSignal): Promise<DesktopIntakeGithubAnswer>
    analyze(chat: DesktopForemanChatRef, links: string, again: boolean, signal?: AbortSignal): Promise<DesktopIntakeGithubAnswer>
    edit(chat: DesktopForemanChatRef, key: string, edit: DesktopGithubProjectsEdit, signal?: AbortSignal): Promise<DesktopIntakeGithubAnswer>
}

async function request(body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<DesktopIntakeGithubAnswer> {
    const response = await fetch('/api/desktop/foreman/intake', {
        method: 'POST', cache: 'no-store', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    })
    const value = await response.json().catch(() => null) as { record?: unknown; message?: unknown; error?: unknown } | null
    if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : 'The GitHub projects could not be read.')
    const record = value?.record == null ? null : desktopGithubProjectsRecordSchema.parse(value.record)
    return { record, message: typeof value?.message === 'string' ? value.message.slice(0, 600) : null }
}

export const desktopIntakeGithubClient: DesktopIntakeGithubPorts = {
    read: (chat, signal) => request({ action: 'github-read', chat }, 20_000, signal),
    // Longer than the whole read and the model pass together.
    analyze: (chat, links, again, signal) => request({ action: 'github-analyze', chat, links, ...(again && { again: true }) }, 150_000, signal),
    edit: (chat, key, edit, signal) => request({ action: 'github-edit', chat, key, edit }, 20_000, signal),
}

type Snapshot = {
    loaded: boolean
    open: boolean
    text: string
    record: DesktopGithubProjectsRecord | null
    reading: boolean
    /** What the server said about the links it was given. */
    message: string | null
    error: string | null
}
type Entry = { snapshot: Snapshot; listeners: Set<() => void>; loading: boolean; run: number }
const EMPTY: Snapshot = { loaded: false, open: false, text: '', record: null, reading: false, message: null, error: null }
const entries = new Map<string, Entry>()
const entryOf = (chat: DesktopForemanChatRef): Entry => {
    const key = JSON.stringify([chat.workspaceId, chat.chatId])
    let entry = entries.get(key)
    if (!entry) { entry = { snapshot: EMPTY, listeners: new Set(), loading: false, run: 0 }; entries.set(key, entry) }
    return entry
}
function publish(entry: Entry, patch: Partial<Snapshot>) {
    entry.snapshot = { ...entry.snapshot, ...patch }
    for (const listener of [...entry.listeners]) listener()
}
/** Test seam: forget every conversation's mirrored state. */
export function resetDesktopIntakeGithub() { entries.clear() }

const sameSet = (text: string, record: DesktopGithubProjectsRecord | null) => {
    const ids = parseGithubRepositoryLinks(text).repositories.map(repository => repository.id).sort()
    const read = record ? record.projects.map(project => project.id).sort() : []
    return ids.length === read.length && ids.every((id, index) => id === read[index])
}

export type DesktopIntakeGithubController = Snapshot & {
    /** Repositories the field holds now. */
    count: number
    /** Plain message for entries that were refused or left out, from the text as typed. */
    refusal: string | null
    /** The field's set is not the one that was read. */
    dirty: boolean
    setOpen(open: boolean): void
    setText(text: string): void
    /** Reads the repositories in the field. `again` reads GitHub afresh. */
    analyze(again?: boolean): void
    /** Reads only when the field changed since the last read: what Next does. */
    commit(): void
    edit(edit: DesktopGithubProjectsEdit): void
}

export function useDesktopIntakeGithub({ chat, active = true, ports = desktopIntakeGithubClient }: {
    chat: DesktopForemanChatRef
    active?: boolean
    ports?: DesktopIntakeGithubPorts
}): DesktopIntakeGithubController {
    const entry = useMemo(() => entryOf(chat), [chat.workspaceId, chat.chatId])
    const subscribe = useCallback((listener: () => void) => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener) } }, [entry])
    const snapshot = useSyncExternalStore(subscribe, () => entry.snapshot, () => entry.snapshot)
    const ref = useMemo(() => ({ workspaceId: chat.workspaceId, chatId: chat.chatId }), [chat.workspaceId, chat.chatId])

    useEffect(() => {
        if (!active || entry.snapshot.loaded || entry.loading) return
        entry.loading = true
        // Restoring shows what was saved and starts no read.
        ports.read(ref).then(answer => {
            const untouched = !entry.snapshot.text && !entry.snapshot.record
            publish(entry, {
                loaded: true,
                ...(untouched && answer.record && { record: answer.record, open: true, text: answer.record.projects.map(project => project.url).join('\n') }),
            })
        }).catch(() => publish(entry, { loaded: true })).finally(() => { entry.loading = false })
    }, [entry, ports, ref, active])

    const analyze = useCallback((again = false) => {
        if (!active || entry.snapshot.reading) return
        const text = entry.snapshot.text
        const run = ++entry.run
        publish(entry, { reading: true, error: null, message: null })
        ports.analyze(ref, text, again).then(answer => {
            if (entry.run !== run) return
            // An answer for a set the owner has since changed is not shown as the current one.
            publish(entry, { reading: false, message: answer.message, ...(entry.snapshot.text === text && { record: answer.record }) })
        }).catch(error => {
            if (entry.run === run) publish(entry, { reading: false, error: error instanceof Error && error.message ? error.message : 'The GitHub projects could not be read.' })
        })
    }, [entry, ports, ref, active])

    const edit = useCallback((change: DesktopGithubProjectsEdit) => {
        const current = entry.snapshot.record
        if (!active || !current || entry.snapshot.reading) return
        // Shown at once, then replaced by what was saved; a refused edit puts the saved list back.
        publish(entry, { record: applyGithubProjectsEdit(current, change), error: null })
        ports.edit(ref, current.key, change).then(answer => {
            if (entry.snapshot.record?.key === current.key && answer.record) publish(entry, { record: answer.record })
        }).catch(error => {
            if (entry.snapshot.record?.key !== current.key) return
            publish(entry, { error: error instanceof Error && error.message ? error.message : 'That change could not be saved.' })
            ports.read(ref).then(answer => { if (answer.record) publish(entry, { record: answer.record }) }).catch(() => {})
        })
    }, [entry, ports, ref, active])

    const reading = useMemo(() => parseGithubRepositoryLinks(snapshot.text), [snapshot.text])
    const dirty = !sameSet(snapshot.text, snapshot.record)
    return {
        ...snapshot,
        count: reading.repositories.length,
        refusal: githubRepositoryLinksMessage(reading),
        dirty,
        setOpen: useCallback((open: boolean) => { if (active) publish(entry, { open }) }, [entry, active]),
        setText: useCallback((text: string) => { if (active) publish(entry, { text: text.slice(0, 4000), error: null }) }, [entry, active]),
        analyze,
        commit: useCallback(() => {
            const state = entry.snapshot
            // An emptied field is told to the server too, so a set that was removed is no longer passed on.
            if (state.open && !sameSet(state.text, state.record)) analyze()
        }, [entry, analyze]),
        edit,
    }
}
