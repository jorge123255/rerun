'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { awaitDesktopUpload, desktopAttachmentSizes, importDesktopUpload, preflightDesktopUploads, type DesktopUploadItem } from './composer-upload'
import { dismissDesktopUploadAttempt, readDesktopUploadAttempts, reserveDesktopUploadAttempt } from './composer-upload-attempts'
import { pendingTabWrite } from './tab-writes'

type Job = { item: DesktopUploadItem; file?: File; reserved: boolean; controller?: AbortController }
type Options = {
    agentId: string; ownerKey: string; tabUid?: string; active?: boolean; attachedPaths: readonly string[]
    onConfirmed: (path: string) => boolean | Promise<boolean>
    onNotice: (message: string | null) => void
}
const UNCERTAIN = 'The import result could not be confirmed. This file may already be in this coworker’s Files. Check Files, then dismiss this upload status before sending.'
type Scope = { owner: string; agentId: string; tabUid?: string; controller: AbortController }

/** Validation, publication and draft acknowledgment share one cancellable owner-scoped drain.
 * A durable warning precedes every file POST; it never claims that the file was imported. */
export function useDesktopComposerUploads(options: Options) {
    const latest = useRef(options)
    latest.current = options
    const mounted = useRef(true)
    const scope = useRef<Scope | null>(null)
    const jobs = useRef(new Map<string, Job>())
    const attached = useRef<readonly string[]>(options.attachedPaths)
    attached.current = options.attachedPaths
    const chain = useRef<Promise<void>>(Promise.resolve())
    const pending = useRef(0)
    const loaded = useRef(false)
    const admissionFailures = useRef(0)
    const [state, setState] = useState<{ items: DesktopUploadItem[]; active: boolean; loaded: boolean }>({ items: [], active: false, loaded: false })
    const publish = useCallback(() => {
        if (mounted.current) setState({ items: [...jobs.current.values()].map(job => ({ ...job.item })), active: pending.current > 0, loaded: loaded.current })
    }, [])
    const live = useCallback((target: Scope) => mounted.current && scope.current === target && !target.controller.signal.aborted
        && latest.current.ownerKey === target.owner && latest.current.agentId === target.agentId && latest.current.active !== false, [])

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; scope.current?.controller.abort() }
    }, [])

    useEffect(() => {
        scope.current?.controller.abort()
        const previous = scope.current
        const target: Scope = { owner: options.ownerKey, agentId: options.agentId, tabUid: options.tabUid, controller: new AbortController() }
        scope.current = target
        chain.current = Promise.resolve()
        pending.current = 0
        loaded.current = false
        // Already-reserved attempts remain on disk even if this owner disappears. Reopening
        // hydrates them as uncertain, never as successful attachments or automatically retried jobs.
        if (previous?.owner !== target.owner) jobs.current.clear()
        else for (const [id, job] of jobs.current) {
            job.controller?.abort()
            if (job.reserved) { job.item.status = 'unresolved'; job.item.error = UNCERTAIN }
            else jobs.current.delete(id)
        }
        if (options.active === false) { publish(); return () => target.controller.abort() }
        pending.current++
        publish()
        const hydrate = async () => {
            try {
                if (target.tabUid) {
                    await awaitDesktopUpload(Promise.resolve(pendingTabWrite(target.agentId)), target.controller.signal)
                    const attempts = await awaitDesktopUpload(readDesktopUploadAttempts(target.agentId, target.tabUid, target.controller.signal), target.controller.signal)
                    if (!live(target)) return
                    for (const attempt of attempts) jobs.current.set(attempt.id, { item: { ...attempt, status: 'unresolved', error: UNCERTAIN }, reserved: true })
                }
                if (live(target)) loaded.current = true
            } catch {
                if (live(target)) latest.current.onNotice('Could not check unfinished imports. Reopen this chat to try again.')
            } finally {
                if (scope.current === target) { pending.current--; publish() }
            }
        }
        chain.current = hydrate()
        return () => target.controller.abort()
        // Each active cycle owns its async callbacks, including a close and immediate reopen.
    }, [options.ownerKey, options.agentId, options.tabUid, options.active, publish, live])

    const schedule = useCallback((work: (target: Scope) => Promise<void>) => {
        const target = scope.current
        if (!target || !live(target)) return Promise.resolve()
        pending.current++
        publish()
        const next = chain.current.catch(() => {}).then(async () => {
            if (!live(target) || !loaded.current) return
            await work(target)
        }).catch(() => {
            if (live(target)) { admissionFailures.current++; latest.current.onNotice('Could not finish preparing the upload. Check Files before trying again.') }
        }).finally(() => {
            if (scope.current === target) { pending.current--; publish() }
        })
        chain.current = next
        return next
    }, [publish, live])

    const importJob = useCallback(async (target: Scope, job: Job) => {
        if (!live(target) || !job.file) return
        const signal = AbortSignal.any([target.controller.signal, (job.controller = new AbortController()).signal])
        let uncertainty = UNCERTAIN
        job.item.status = 'importing'; job.item.error = null
        publish()
        try {
            if (target.tabUid) {
                // Mark uncertain before awaiting admission: a lost reservation ACK is itself
                // unresolved, and must not become permission to POST the file a second time.
                job.reserved = true
                const reservation = await awaitDesktopUpload(reserveDesktopUploadAttempt(target.agentId, target.tabUid, {
                    id: job.item.id, name: job.item.name, size: job.item.size,
                }, signal), signal)
                if (!live(target) || signal.aborted) return
                if (!reservation.created) throw new Error('Previous admission is uncertain')
            }
            if (!live(target) || signal.aborted) return
            const result = await awaitDesktopUpload(importDesktopUpload(target.agentId, job.file, signal), signal)
            if (!live(target) || signal.aborted) return
            if (!result.ok) {
                if (result.kind === 'ambiguous') throw new Error('Unknown publication')
                if (target.tabUid) await awaitDesktopUpload(dismissDesktopUploadAttempt(target.agentId, target.tabUid, job.item.id, signal), signal)
                if (!live(target)) return
                job.reserved = false; job.item.status = 'error'; job.item.error = result.message
                return
            }
            if (!await awaitDesktopUpload(Promise.resolve(latest.current.onConfirmed(result.path)), signal)) {
                uncertainty = 'The file was imported, but this draft could not take it. Attach it from Files instead after resolving the draft save.'
                throw new Error('Draft not saved')
            }
            if (!live(target) || signal.aborted) return
            attached.current = [...attached.current.filter(path => path !== result.path), result.path]
            if (target.tabUid) await awaitDesktopUpload(dismissDesktopUploadAttempt(target.agentId, target.tabUid, job.item.id, signal), signal)
            if (live(target) && !signal.aborted) jobs.current.delete(job.item.id)
        } catch {
            if (scope.current === target && mounted.current) { job.item.status = 'unresolved'; job.item.error = uncertainty }
        } finally { publish() }
    }, [publish, live])

    const start = useCallback((files: File[]) => schedule(async target => {
        if (!files.length) return
        latest.current.onNotice(null)
        const paths = [...attached.current]
        const sizes = await awaitDesktopUpload(desktopAttachmentSizes(target.agentId, paths, target.controller.signal), target.controller.signal)
        const preflight = await awaitDesktopUpload(preflightDesktopUploads({ files, attachedPaths: paths, attachedSizes: sizes, pending: [] }), target.controller.signal)
        if (!live(target)) return
        // The picker/removal are disabled during this drain. A programmatic draft update is
        // still allowed; if its attachment set changed, require a fresh selection and budget.
        if (JSON.stringify(paths) !== JSON.stringify(attached.current)) {
            admissionFailures.current++
            latest.current.onNotice('The attached files changed. Choose these files again.'); return
        }
        const notices = [...preflight.blockers, ...preflight.rejected.map(item => '“' + item.file.name + '” ' + item.reason)]
        if (notices.length) { admissionFailures.current++; latest.current.onNotice(notices.slice(0, 3).join(' ')) }
        const batch = preflight.accepted.map(file => ({ item: { id: crypto.randomUUID(), name: file.name, size: file.size, status: 'queued' as const, error: null }, file, reserved: false } as Job))
        for (const job of batch) jobs.current.set(job.item.id, job)
        publish()
        for (const job of batch) {
            if (!live(target)) break
            if (jobs.current.has(job.item.id)) await importJob(target, job)
        }
    }), [schedule, publish, importJob, live])

    const retry = useCallback((id: string) => {
        const job = jobs.current.get(id)
        if (!job?.file || job.item.status !== 'error' || job.reserved) return
        return schedule(async target => {
            const paths = [...attached.current]
            const sizes = await awaitDesktopUpload(desktopAttachmentSizes(target.agentId, paths, target.controller.signal), target.controller.signal)
            const result = await awaitDesktopUpload(preflightDesktopUploads({ files: [job.file!], attachedPaths: paths, attachedSizes: sizes, pending: [] }), target.controller.signal)
            if (!live(target)) return
            if (!result.accepted.length || JSON.stringify(paths) !== JSON.stringify(attached.current)) {
                job.item.error = result.blockers[0] ?? result.rejected[0]?.reason ?? 'The attached files changed. Try again.'; publish(); return
            }
            await importJob(target, job)
        })
    }, [schedule, publish, importJob, live])

    const remove = useCallback((id: string) => {
        const job = jobs.current.get(id), target = scope.current
        if (!job || !target || !live(target)) return
        if (job.item.status === 'importing') {
            job.controller?.abort()
            job.item.status = 'unresolved'; job.item.error = UNCERTAIN
            publish(); return
        }
        if (!job.reserved) { jobs.current.delete(id); publish(); return }
        void schedule(async current => {
            await awaitDesktopUpload(dismissDesktopUploadAttempt(current.agentId, current.tabUid!, id, current.controller.signal), current.controller.signal)
            if (live(current)) { jobs.current.delete(id); publish() }
        })
    }, [schedule, publish, live])

    const settle = useCallback(async () => {
        const target = scope.current
        const failures = admissionFailures.current
        if (!target || !live(target)) return false
        try {
            for (;;) {
                const work = chain.current
                await awaitDesktopUpload(work, target.controller.signal)
                if (!live(target)) return false
                if (work === chain.current) return loaded.current && failures === admissionFailures.current
            }
        } catch { return false }
    }, [live])
    const hasBlocked = useCallback(() => !loaded.current || [...jobs.current.values()].some(job => job.item.status === 'error' || job.item.status === 'unresolved'), [])
    const isBusy = useCallback(() => pending.current > 0, [])
    return { ...state, hasBlocked, isBusy, start, remove, retry, settle }
}
