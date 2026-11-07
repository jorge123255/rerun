import { MAX_UPLOAD_FILE_BYTES } from '@rerun/contracts'
import { admitFilesImportPath, FILES_IMPORT_ESCAPE, filesImportTooLarge } from './paths'
import {
    filesImportFailureCode,
    filesImportRetriesAutomatically,
    FilesImportWriteError,
    type FilesImportBatchReceipt,
    type FilesImportCode,
    type FilesImportEntry,
    type FilesImportItem,
    type FilesImportWriter,
} from './types'

const RETRY_MS = 1000
const PUBLISH_MS = 100
const MB = 1024 * 1024

type Job = FilesImportItem & {
    read: () => Promise<Uint8Array>
    attempt: number
    holdUntil: number | null
    controller: AbortController | null
    bytesPerSecond: number | null
    lastAt: number
    lastLoaded: number
}

export type FilesImportQueueOptions = {
    write: FilesImportWriter
    concurrency?: number
    onChange?: (items: FilesImportItem[]) => void
    onRejected?: (message: string) => void
    onFileSaved?: (item: FilesImportItem) => void
    schedule?: (fn: () => void, ms: number) => void
    now?: () => number
    id?: () => string
}

export const FILES_IMPORT_RELOAD_MS = 500

/** Reload the open folder only after a confirmed save in that folder. */
export function filesImportShouldReload(openDir: string, item: { dir: string; saved: boolean }): boolean {
    return item.saved === true && item.dir === openDir
}

/** Says imported only when every item was confirmed saved. */
export function filesImportSettlement(items: FilesImportItem[]): string | null {
    if (items.length === 0) return null
    if (items.some(item => item.status === 'queued' || item.status === 'uploading' || item.status === 'finishing')) return null
    const failed = items.filter(item => item.saved !== true).length
    if (failed === items.length) return 'Import failed'
    if (failed > 0) return `${failed} of ${items.length} files failed to import`
    return `${items.length} ${items.length === 1 ? 'file' : 'files'} imported`
}

export function filesImportTotalProgress(items: FilesImportItem[]): number {
    const total = items.reduce((sum, item) => sum + item.size, 0)
    if (total <= 0) return 0
    return items.reduce((sum, item) => sum + item.loaded, 0) / total
}

function publicItem(job: Job): FilesImportItem {
    return {
        id: job.id,
        name: job.name,
        dir: job.dir,
        path: job.path,
        size: job.size,
        status: job.status,
        loaded: job.loaded,
        progress: job.progress,
        etaMs: job.etaMs,
        error: job.error,
        saved: job.saved,
        code: job.code,
    }
}

function unsafeName(name: string): boolean {
    return !name || name === '.' || name === '..' || /[\\/\0]/.test(name)
}

/**
 * One local import at a time per file, up to three at once.
 * A dropped writer error retries once after 1000ms. HTTP refusals, reserved paths,
 * and an unconfirmed link stay in error until a manual retry. Cancel removes the job.
 */
export class FilesImportQueue {
    private readonly jobs = new Map<string, Job>()
    private running = 0
    private pendingPublish = false
    private readonly concurrency: number
    private readonly now: () => number
    private readonly schedule: (fn: () => void, ms: number) => void
    private readonly nextId: () => string

    constructor(private readonly options: FilesImportQueueOptions) {
        this.concurrency = options.concurrency ?? 3
        this.now = options.now ?? (() => Date.now())
        this.schedule = options.schedule ?? ((fn, ms) => { setTimeout(fn, ms) })
        this.nextId = options.id ?? (() => crypto.randomUUID())
    }

    enqueue(entries: FilesImportEntry[], rootDir = ''): string[] {
        const accepted: string[] = []
        const oversized: string[] = []
        for (const entry of entries) {
            if (typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size > MAX_UPLOAD_FILE_BYTES) {
                oversized.push(entry.name || 'file')
                continue
            }
            const name = entry.name
            const dir = [rootDir, entry.subDir].filter(Boolean).join('/')
            const path = [dir, name].filter(Boolean).join('/')
            const id = this.nextId()
            const admission = unsafeName(name) || filesImportTooLarge(entry.size)
                ? { ok: false as const, code: 'unsafe_path' as const, message: FILES_IMPORT_ESCAPE(path) }
                : admitFilesImportPath(path)
            const job: Job = {
                id,
                name,
                dir,
                path,
                size: entry.size,
                status: admission.ok ? 'queued' : 'error',
                loaded: 0,
                progress: 0,
                etaMs: null,
                error: admission.ok ? null : admission.message,
                saved: false,
                code: admission.ok ? null : admission.code,
                read: entry.read,
                attempt: 0,
                holdUntil: null,
                controller: null,
                bytesPerSecond: null,
                lastAt: 0,
                lastLoaded: 0,
            }
            this.jobs.set(id, job)
            accepted.push(id)
        }
        if (oversized.length > 0) {
            const names = oversized.slice(0, 2).join(', ')
            const rest = oversized.length > 2 ? ` and ${oversized.length - 2} more` : ''
            this.options.onRejected?.(`${names}${rest} ${oversized.length > 1 ? 'are' : 'is'} over the ${MAX_UPLOAD_FILE_BYTES / MB} MB limit.`)
        }
        this.pump()
        return accepted
    }

    cancel(id: string) {
        const job = this.jobs.get(id)
        if (!job) return
        if (job.controller) {
            job.controller.abort()
            return
        }
        this.jobs.delete(id)
        this.publish(true)
    }

    cancelAll() {
        for (const id of [...this.jobs.keys()]) this.cancel(id)
    }

    retry(id: string) {
        const job = this.jobs.get(id)
        if (!job || job.status !== 'error') return
        job.status = 'queued'
        job.attempt = 0
        job.holdUntil = null
        job.loaded = 0
        job.progress = 0
        job.etaMs = null
        job.error = null
        job.code = null
        job.saved = false
        job.bytesPerSecond = null
        this.pump()
    }

    clearFinished() {
        for (const [id, job] of [...this.jobs]) {
            if (job.status === 'done') this.jobs.delete(id)
        }
        this.publish(true)
    }

    items(): FilesImportItem[] {
        return [...this.jobs.values()].map(publicItem)
    }

    receipt(): FilesImportBatchReceipt {
        const items = this.items()
        return {
            items,
            savedCount: items.filter(item => item.saved).length,
            failedCount: items.filter(item => item.status === 'error').length,
            active: items.some(item => item.status === 'queued' || item.status === 'uploading' || item.status === 'finishing'),
        }
    }

    private pump() {
        for (const job of this.jobs.values()) {
            if (this.running >= this.concurrency) break
            if (job.status !== 'queued') continue
            if (job.holdUntil != null && this.now() < job.holdUntil) continue
            this.start(job)
        }
        this.publish(true)
    }

    private start(job: Job) {
        const admission = unsafeName(job.name) ? { ok: false as const, code: 'unsafe_path' as const, message: FILES_IMPORT_ESCAPE(job.path) } : admitFilesImportPath(job.path)
        if (!admission.ok) {
            job.status = 'error'
            job.saved = false
            job.code = admission.code
            job.error = admission.message
            job.holdUntil = null
            return
        }
        job.holdUntil = null
        job.status = 'uploading'
        job.error = null
        job.code = null
        job.saved = false
        const controller = new AbortController()
        job.controller = controller
        this.running += 1
        void this.run(job, controller)
    }

    private async run(job: Job, controller: AbortController) {
        try {
            const bytes = await job.read()
            if (controller.signal.aborted || !this.jobs.has(job.id)) {
                this.jobs.delete(job.id)
                this.publish(true)
                return
            }
            if (filesImportTooLarge(bytes.byteLength)) {
                throw new FilesImportWriteError(`This file is larger than the ${MAX_UPLOAD_FILE_BYTES / 1024 / 1024} MB upload limit.`, 'too_large', 413)
            }
            const result = await this.options.write({
                path: job.path,
                name: job.name,
                dir: job.dir,
                bytes,
                signal: controller.signal,
                onProgress: (loaded, total) => this.onProgress(job, loaded, total),
            })
            if (controller.signal.aborted || !this.jobs.has(job.id)) {
                this.jobs.delete(job.id)
                this.publish(true)
                return
            }
            if (result?.saved !== true || result.path !== job.path) {
                throw new FilesImportWriteError('The file import result could not be confirmed. Check Files before retrying.', 'unconfirmed', 500)
            }
            job.status = 'done'
            job.saved = true
            job.loaded = job.size
            job.progress = 1
            job.etaMs = null
            job.error = null
            job.code = null
            this.publish(true)
            this.options.onFileSaved?.(publicItem(job))
        } catch (error) {
            if (!this.jobs.has(job.id)) return
            const code = filesImportFailureCode(error)
            if (controller.signal.aborted || code === 'aborted') {
                this.jobs.delete(job.id)
                this.publish(true)
                return
            }
            if (filesImportRetriesAutomatically(code) && job.attempt === 0) {
                job.attempt += 1
                job.status = 'queued'
                job.loaded = 0
                job.progress = 0
                job.etaMs = null
                job.saved = false
                job.error = null
                job.code = null
                job.bytesPerSecond = null
                job.holdUntil = this.now() + RETRY_MS
                this.publish(true)
                this.schedule(() => this.pump(), RETRY_MS)
                return
            }
            this.fail(job, code, error instanceof Error ? error.message : 'Import failed')
        } finally {
            if (job.controller === controller) job.controller = null
            this.running = Math.max(0, this.running - 1)
            this.pump()
        }
    }

    private fail(job: Job, code: FilesImportCode, message: string) {
        job.status = 'error'
        job.saved = false
        job.code = code
        job.error = message
        job.etaMs = null
        this.publish(true)
    }

    private onProgress(job: Job, loaded: number, total: number) {
        if (!this.jobs.has(job.id) || job.status === 'done' || job.status === 'error') return
        const now = this.now()
        const elapsed = (now - job.lastAt) / 1000
        if (job.lastAt > 0 && elapsed > 0.15) {
            const instant = (loaded - job.lastLoaded) / elapsed
            job.bytesPerSecond = job.bytesPerSecond == null ? instant : job.bytesPerSecond * 0.7 + instant * 0.3
            job.lastAt = now
            job.lastLoaded = loaded
        } else if (job.lastAt === 0) {
            job.lastAt = now
            job.lastLoaded = loaded
        }
        job.loaded = loaded
        job.progress = total > 0 ? loaded / total : 0
        job.etaMs = job.bytesPerSecond != null && job.bytesPerSecond > 0 ? ((total - loaded) / job.bytesPerSecond) * 1000 : null
        if (total > 0 && loaded >= total && job.status === 'uploading') job.status = 'finishing'
        this.publish(false)
    }

    private publish(immediate: boolean) {
        if (!this.options.onChange) return
        if (immediate) {
            this.pendingPublish = false
            this.options.onChange(this.items())
            return
        }
        if (this.pendingPublish) return
        this.pendingPublish = true
        this.schedule(() => {
            this.pendingPublish = false
            this.options.onChange?.(this.items())
        }, PUBLISH_MS)
    }
}
