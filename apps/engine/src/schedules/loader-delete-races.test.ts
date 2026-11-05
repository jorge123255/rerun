import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, afterEach, expect, test, vi } from 'vitest'

const directory = mkdtempSync(resolve(tmpdir(), 'rerun-schedule-delete-race-'))
process.env.RERUN_DATA_DIR = directory
process.env.RERUN_API_KEY = ''

const boundary = vi.hoisted(() => ({
    path: '', key: '', deleting: false,
    writeEntered: (() => {}) as () => void,
    writeWait: Promise.resolve(),
    deletionQueued: (() => {}) as () => void,
    deletionFinished: (() => {}) as () => void,
}))
vi.mock('../runtime/notify.js', async original => ({ ...await original<typeof import('../runtime/notify.js')>(), sendNotification: async () => ({ delivered: true }) }))
vi.mock('../lib/atomic-write.js', async original => {
    const actual = await original<typeof import('../lib/atomic-write.js')>()
    return { ...actual, writeFileAtomic: async (path: string, content: string) => {
        if (path === boundary.path) { boundary.writeEntered(); await boundary.writeWait }
        return actual.writeFileAtomic(path, content)
    } }
})
vi.mock('../lib/lock.js', async original => {
    const actual = await original<typeof import('../lib/lock.js')>()
    return { ...actual, withKeyedLock: <T>(key: string, action: () => Promise<T>) => {
        if (boundary.deleting && key === boundary.key) boundary.deletionQueued()
        return actual.withKeyedLock(key, action)
    } }
})
vi.mock('node:fs/promises', async original => {
    const actual = await original<typeof import('node:fs/promises')>()
    return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
        await actual.rm(...args)
        if (boundary.deleting && String(args[0]) === boundary.path) boundary.deletionFinished()
    } }
})

const { rm } = await import('node:fs/promises')
const { scheduleFile } = await import('../config/paths.js')
const { writeSchedule, updateScheduleAt, consumeDesktopSchedule, deleteSchedule, scheduleExists, listSchedules } = await import('./loader.js')

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(yes => { resolve = yes })
    return { promise, resolve }
}
afterEach(() => { boundary.path = ''; boundary.key = ''; boundary.deleting = false })
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

test.each(['edit', 'consume'] as const)('delete cannot be undone by an overlapping %s whose file read already completed', async operation => {
    const owner = `delete-${operation}`
    const schedule = await writeSchedule(owner, { name: 'Daily', cron: '0 9 * * *', body: 'Original instructions' })
    const writerEntered = deferred(), resumeWriter = deferred(), queued = deferred(), removed = deferred()
    boundary.path = scheduleFile(owner, schedule.slug)
    boundary.key = `schedule:${owner}:${schedule.slug}`
    boundary.writeEntered = writerEntered.resolve
    boundary.writeWait = resumeWriter.promise
    boundary.deletionQueued = queued.resolve
    boundary.deletionFinished = removed.resolve
    // Stop the real edit/consume after reading the original file, immediately before its
    // atomic replacement. The original unfenced delete removes the file during this pause.
    const mutation = operation === 'edit'
        ? updateScheduleAt(owner, schedule.slug, { body: 'Edited instructions' })
        : consumeDesktopSchedule(owner, schedule, '2026-11-04T12:00:00.000Z')
    let deletion: Promise<void> | undefined
    try {
        await writerEntered.promise
        boundary.deleting = true
        deletion = deleteSchedule(owner, schedule.slug)
        // A fixed delete queues behind the writer. The old delete instead completes rm;
        // observing either boundary makes this race deterministic without sleeps.
        await Promise.race([queued.promise, removed.promise])
        resumeWriter.resolve()
        await Promise.all([mutation, deletion])
        expect(scheduleExists(owner, schedule.slug)).toBe(false)
        expect(await listSchedules(owner)).toEqual([])
    } finally {
        resumeWriter.resolve()
        await Promise.allSettled([mutation, ...(deletion ? [deletion] : [])])
    }
})
