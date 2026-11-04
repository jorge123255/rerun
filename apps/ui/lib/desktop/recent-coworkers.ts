'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { desktopRecentCoworkersSchema, type DesktopRecentCoworkers, type DesktopRecentCoworkerVisit } from './recent-coworkers.schema'
import { isDesktopQuitting, subscribeDraftShutdown } from './draft-writes'

const EMPTY: DesktopRecentCoworkers = { revision: 0, recentAgentIds: [] }
const ERROR = 'Could not save recent coworkers.'
const REQUEST_TIMEOUT_MS = 5_000
const FLUSH_TIMEOUT_MS = 1_500
const push = (ids: readonly string[], id: string) => [id, ...ids.filter(previous => previous !== id)].slice(0, 5)
type Visit = { sequence: number; agentId: string }
type Attempt = DesktopRecentCoworkerVisit & { sequence: number }
export type DesktopRecentCoworkersState = { recentAgentIds: string[]; saving: boolean; error?: string }

// One ordered writer survives control-center unmounts. The accepted list is never exposed without
// replaying later local visits over it, so a slow ACK cannot erase a more recent selection.
export class DesktopRecentCoworkersController {
    private saved: DesktopRecentCoworkers
    private pending: Visit[] = []
    private attempt?: Attempt
    private work?: Promise<void>
    private request?: AbortController
    private listeners = new Set<() => void>()
    private roster?: Set<string>
    private rejected = new Set<string>()
    private selected: string | null | undefined
    private sequence = 0
    private error?: string
    private disposed = false
    private state: DesktopRecentCoworkersState

    constructor(initial: DesktopRecentCoworkers = EMPTY) {
        this.saved = desktopRecentCoworkersSchema.parse(initial)
        this.state = { recentAgentIds: this.saved.recentAgentIds, saving: false }
    }

    getSnapshot = () => this.state
    subscribe = (listener: () => void) => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }

    private publish() {
        if (this.disposed) return
        const visible = (id: string) => !this.rejected.has(id) && (!this.roster || this.roster.has(id))
        let ids = this.saved.recentAgentIds.filter(visible)
        for (const visit of this.pending) if (visible(visit.agentId)) ids = push(ids, visit.agentId)
        this.state = {
            recentAgentIds: ids,
            saving: this.pending.length > 0 && !this.error,
            ...(this.error ? { error: this.error } : {}),
        }
        for (const listener of this.listeners) listener()
    }

    setRoster(ids: readonly string[]) {
        this.roster = new Set(ids)
        this.publish()
    }

    observeSelection(agentId: string | null) {
        if (this.disposed || isDesktopQuitting()) return
        const previous = this.selected
        this.selected = agentId
        // Hydrating/restoring a selection is not a new visit. Strict Mode and remounts keep the
        // same last observation, and never enqueue the same visit twice.
        if (previous === undefined || previous === agentId || !agentId) return
        if (this.roster && !this.roster.has(agentId)) return
        this.pending.push({ sequence: ++this.sequence, agentId })
        this.publish()
        if (!this.error) void this.start()
    }

    retry = () => {
        if (this.disposed) return
        this.error = undefined
        this.publish()
        void this.start()
    }

    private async post(attempt: Attempt) {
        const controller = new AbortController()
        this.request = controller
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        const { sequence: _sequence, ...payload } = attempt
        try {
            return await Promise.race([
                fetch('/api/desktop/recent-coworkers', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload), keepalive: true, signal: controller.signal,
                }).then(async response => ({ response, body: await response.json() })),
                new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error(ERROR)), { once: true })),
            ])
        } finally {
            clearTimeout(timeout)
            if (this.request === controller) this.request = undefined
        }
    }

    private async drain() {
        while (!this.disposed && !this.error && this.pending.length) {
            const visit = this.pending[0]
            if (!this.attempt && this.roster && !this.roster.has(visit.agentId)) {
                this.pending.shift()
                this.publish()
                continue
            }
            const attempt = this.attempt ??= { ...visit, baseRevision: this.saved.revision, requestId: crypto.randomUUID() }
            const { response, body } = await this.post(attempt)
            if (this.disposed || this.error) return
            if (response.status === 404) {
                this.rejected.add(attempt.agentId)
                this.pending = this.pending.filter(item => item.agentId !== attempt.agentId)
                this.attempt = undefined
                this.publish()
                continue
            }
            if (response.status === 409) {
                const recent = desktopRecentCoworkersSchema.parse(body?.recent)
                if (recent.revision <= attempt.baseRevision || recent.revision < this.saved.revision) throw new Error(ERROR)
                this.saved = recent
                // The receipt may have been accepted before its ACK was lost and superseded by
                // another view. Never turn that older visit into a new one above newer history.
                this.pending = this.pending.filter(item => item.sequence !== attempt.sequence)
                this.attempt = undefined
                this.publish()
                continue
            }
            if (!response.ok) throw new Error(ERROR)
            const recent = desktopRecentCoworkersSchema.parse(body)
            if (recent.revision <= attempt.baseRevision || recent.revision < this.saved.revision) throw new Error(ERROR)
            this.saved = recent
            this.pending = this.pending.filter(item => item.sequence !== attempt.sequence)
            this.attempt = undefined
            this.publish()
        }
    }

    private start(): Promise<void> {
        if (this.work) return this.work
        if (this.disposed || this.error || !this.pending.length) return Promise.resolve()
        // Defer drain until work is assigned: a subscriber can enqueue a visit during publish.
        const work = Promise.resolve().then(() => this.drain()).catch(() => {
            if (this.disposed) return
            this.error = ERROR
            this.publish()
        })
        this.work = work
        void work.finally(() => {
            if (this.work !== work) return
            this.work = undefined
            if (!this.disposed && !this.error && this.pending.length) void this.start()
        })
        return work
    }

    async flush(): Promise<void> {
        // Recent is best-effort on quit. Do not silently retry an already failed write or hold
        // the native draft-save handshake indefinitely.
        if (this.disposed || this.error || !this.pending.length) return
        let timeout: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<void>(resolve => {
            timeout = setTimeout(() => {
                this.error = ERROR
                this.request?.abort()
                this.publish()
                resolve()
            }, FLUSH_TIMEOUT_MS)
        })
        try {
            await Promise.race([
                (async () => {
                    while (!this.disposed && !this.error && this.pending.length) await this.start()
                })(),
                deadline,
            ])
        } finally {
            clearTimeout(timeout)
        }
    }

    dispose() {
        this.disposed = true
        this.request?.abort()
        this.listeners.clear()
    }
}

let controller: DesktopRecentCoworkersController | undefined
function current(initial?: DesktopRecentCoworkers) {
    if (typeof window === 'undefined') return new DesktopRecentCoworkersController(initial)
    return controller ??= new DesktopRecentCoworkersController(initial)
}

export function useDesktopRecentCoworkers(initial: DesktopRecentCoworkers | undefined, selectedAgentId: string | null, coworkerIds: readonly string[]) {
    const [store] = useState(() => current(initial))
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const quitting = useSyncExternalStore(subscribeDraftShutdown, isDesktopQuitting, () => false)
    const rosterKey = JSON.stringify(coworkerIds)
    useEffect(() => {
        store.setRoster(JSON.parse(rosterKey) as string[])
        store.observeSelection(selectedAgentId)
    }, [store, rosterKey, selectedAgentId, quitting])
    return { ...state, retry: store.retry }
}

export async function flushDesktopRecentCoworkers(): Promise<void> { await controller?.flush() }

// Workspace teardown and isolated component fixtures must not retain an old workspace's writer.
export function resetDesktopRecentCoworkers() {
    controller?.dispose()
    controller = undefined
}
