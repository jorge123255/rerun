'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { desktopAttachmentSizes, importDesktopUpload, preflightDesktopUploads, type DesktopUploadItem, type DesktopUploadStatus } from './composer-upload'

type Job = {
    item: DesktopUploadItem
    file: File
    controller: AbortController
    owner: string
}

type Options = {
    agentId: string
    /** Identifies the composer owner (coworker + tab/draft). A change aborts every job: an
     * in-flight import may still publish server-side, which stays recoverable through Files —
     * nothing here claims the publication was undone. */
    ownerKey: string
    attachedPaths: readonly string[]
    onConfirmed: (path: string) => boolean
    onNotice: (message: string | null) => void
}

const BLOCKED: readonly DesktopUploadStatus[] = ['error', 'unresolved']
const IN_FLIGHT: readonly DesktopUploadStatus[] = ['queued', 'importing']

const formatRejections = (rejected: readonly { file: File; reason: string }[]) => {
    const named = rejected.slice(0, 2).map(item => `“${item.file.name}” ${item.reason}`)
    const rest = rejected.length > 2 ? ` and ${rejected.length - 2} more` : ''
    return `${named.join(', ')}${rest}.`
}

/**
 * Composer uploads for the desktop app: local .txt/.md files imported one at a time through the
 * coworker's files route. Jobs live in a ref and publish on state changes only — there is no
 * byte-level progress to smooth out. Confirmed paths are handed to the draft one at a time in
 * selection order; a definitive refusal becomes a retryable error and an unreadable outcome stays
 * visibly unresolved instead of being retried blindly.
 */
export function useDesktopComposerUploads({ agentId, ownerKey, attachedPaths, onConfirmed, onNotice }: Options) {
    const jobs = useRef(new Map<string, Job>())
    const [items, setItems] = useState<DesktopUploadItem[]>([])
    const mounted = useRef(true)
    const owner = useRef(ownerKey)
    const generation = useRef(0)
    const pumping = useRef(false)
    const starting = useRef<Promise<void>>(Promise.resolve())
    const waiters = useRef<(() => void)[]>([])
    const attached = useRef<readonly string[]>(attachedPaths)
    const callbacks = useRef({ agentId, onConfirmed, onNotice })
    useEffect(() => {
        attached.current = attachedPaths
        callbacks.current = { agentId, onConfirmed, onNotice }
    })

    const publish = useCallback(() => {
        if (mounted.current) setItems([...jobs.current.values()].map(job => job.item))
    }, [])

    const settleWaiters = useCallback(() => {
        if ([...jobs.current.values()].some(job => IN_FLIGHT.includes(job.item.status))) return
        const pending = waiters.current
        waiters.current = []
        pending.forEach(resolve => resolve())
    }, [])

    const abortAll = useCallback(() => {
        for (const job of jobs.current.values()) job.controller.abort()
        jobs.current.clear()
        publish()
        settleWaiters()
    }, [publish, settleWaiters])

    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
            generation.current += 1
            abortAll()
        }
    }, [abortAll])

    useEffect(() => {
        if (owner.current === ownerKey) return
        owner.current = ownerKey
        generation.current += 1
        abortAll()
    }, [ownerKey, abortAll])

    const pump = useCallback(async () => {
        if (pumping.current) return
        pumping.current = true
        try {
            for (;;) {
                const job = [...jobs.current.values()].find(item => item.item.status === 'queued')
                if (!job) break
                job.item.status = 'importing'
                job.item.error = null
                publish()
                const gen = generation.current
                const live = () => mounted.current && gen === generation.current && job.owner === owner.current && jobs.current.has(job.item.id)
                try {
                    const result = await importDesktopUpload(callbacks.current.agentId, job.file, job.controller.signal)
                    if (!live()) continue
                    if (result.ok) {
                        jobs.current.delete(job.item.id)
                        publish()
                        if (callbacks.current.onConfirmed(result.path) === false) {
                            const orphan: Job = { item: { id: job.item.id, name: job.item.name, size: job.item.size, status: 'unresolved', error: 'The file was imported, but this draft could not take it. Attach it from Files instead.' }, file: job.file, controller: new AbortController(), owner: job.owner }
                            jobs.current.set(orphan.item.id, orphan)
                            publish()
                        }
                    } else {
                        job.item.status = result.kind === 'rejected' ? 'error' : 'unresolved'
                        job.item.error = result.message
                        publish()
                    }
                } catch {
                    if (!live()) continue
                    if (job.controller.signal.aborted) {
                        jobs.current.delete(job.item.id)
                        publish()
                        continue
                    }
                    job.item.status = 'unresolved'
                    job.item.error = 'The import result could not be confirmed. Check Files before attaching this file again.'
                    publish()
                }
                settleWaiters()
            }
        } finally {
            pumping.current = false
            publish()
            settleWaiters()
        }
    }, [publish, settleWaiters])

    const enqueue = useCallback((accepted: File[], owner: string) => {
        for (const file of accepted) {
            const id = crypto.randomUUID()
            jobs.current.set(id, { item: { id, name: file.name, size: file.size, status: 'queued', error: null }, file, controller: new AbortController(), owner })
        }
        publish()
        void pump()
    }, [publish, pump])

    const doStart = useCallback(async (files: File[], pickedOwner: string) => {
        if (!files.length || !mounted.current) return
        const gen = generation.current
        const stale = () => !mounted.current || gen !== generation.current || pickedOwner !== owner.current
        callbacks.current.onNotice(null)
        const paths = [...attached.current]
        let sizes: Map<string, number | 'missing'>
        try {
            sizes = await desktopAttachmentSizes(callbacks.current.agentId, paths)
        } catch {
            if (!stale()) callbacks.current.onNotice('Could not check the size of attached files. Try again.')
            return
        }
        if (stale()) return
        let preflight: Awaited<ReturnType<typeof preflightDesktopUploads>>
        try {
            preflight = await preflightDesktopUploads({
                files,
                attachedPaths: paths,
                attachedSizes: sizes,
                pending: [...jobs.current.values()].map(job => ({ size: job.item.size, status: job.item.status })),
            })
        } catch {
            if (!stale()) callbacks.current.onNotice('Could not read one of the selected files. Try again.')
            return
        }
        if (stale()) return
        if (preflight.blockers.length) {
            callbacks.current.onNotice(preflight.blockers.join(' '))
            return
        }
        if (preflight.rejected.length) callbacks.current.onNotice(formatRejections(preflight.rejected))
        if (preflight.accepted.length) enqueue(preflight.accepted, pickedOwner)
    }, [enqueue])

    // Preflights are async, so two quick selections must not race past the shared attachment
    // budget: each start waits for the previous one's jobs to be queued first. The owner is
    // captured at pick time so a selection made before a tab/coworker switch can never land in
    // the next owner's draft.
    const start = useCallback((files: File[]) => {
        const pickedOwner = owner.current
        starting.current = starting.current.then(() => doStart(files, pickedOwner)).catch(() => {})
        return starting.current
    }, [doStart])

    const remove = useCallback((id: string) => {
        const job = jobs.current.get(id)
        if (!job) return
        if (job.item.status === 'importing') {
            job.controller.abort()
            return
        }
        jobs.current.delete(id)
        publish()
        settleWaiters()
    }, [publish, settleWaiters])

    const retry = useCallback((id: string) => {
        const job = jobs.current.get(id)
        if (!job || job.item.status !== 'error') return
        job.item.status = 'queued'
        job.item.error = null
        job.controller = new AbortController()
        publish()
        void pump()
    }, [publish, pump])

    const settle = useCallback(() => {
        if (![...jobs.current.values()].some(job => IN_FLIGHT.includes(job.item.status))) return Promise.resolve()
        return new Promise<void>(resolve => waiters.current.push(resolve))
    }, [])

    const hasBlocked = useCallback(() => [...jobs.current.values()].some(job => BLOCKED.includes(job.item.status)), [])

    return { items, active: items.some(item => IN_FLIGHT.includes(item.status)), hasBlocked, start, remove, retry, settle }
}
