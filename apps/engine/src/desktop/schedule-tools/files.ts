import { lstat, mkdir, readdir, unlink } from 'node:fs/promises'
import matter from 'gray-matter'
import { scheduleFile, schedulesDir } from '../../config/paths.js'
import { withKeyedLock } from '../../lib/lock.js'
import { writeFileAtomic } from '../../lib/atomic-write.js'
import { readSchedule } from '../../schedules/loader.js'
import { DESKTOP_SCHEDULE_TOOL_MESSAGES as M } from '@rerun/contracts'
import { desktopScheduleDefinitionRevision } from './revision.js'
import type { DesktopScheduleDefinition, DesktopScheduleFilePort } from './types.js'

const MAX_BYTES = 262144

export class DesktopScheduleFileConflict extends Error {
    constructor() {
        super('Schedule definition changed')
        this.name = 'DesktopScheduleFileConflict'
    }
}

function serialize(schedule: DesktopScheduleDefinition): string {
    return matter.stringify(`\n${schedule.body.trim()}\n`, {
        name: schedule.name,
        description: schedule.description,
        enabled: schedule.enabled,
        cron: schedule.cron,
        runAt: schedule.runAt,
        timezone: schedule.timezone,
        lastRunAt: schedule.lastRunAt,
        connection: schedule.connectionId,
        provider: schedule.provider,
        model: schedule.model,
        createdAt: schedule.createdAt,
    })
}

async function safeDirectory(engineAgentId: string) {
    await mkdir(schedulesDir(engineAgentId), { recursive: true, mode: 0o700 })
    const root = await lstat(schedulesDir(engineAgentId))
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(M.fileUnsafe)
}

async function readDefinition(engineAgentId: string, slug: string): Promise<DesktopScheduleDefinition | null> {
    let file
    try {
        const root = await lstat(schedulesDir(engineAgentId))
        if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(M.fileUnsafe)
        file = await lstat(scheduleFile(engineAgentId, slug))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    }
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > MAX_BYTES) throw new Error(M.fileUnsafe)
    const schedule = await readSchedule(engineAgentId, slug)
    return { ...schedule, provider: schedule.provider, model: schedule.model }
}

export function desktopScheduleFiles(): DesktopScheduleFilePort {
    return {
        async list(engineAgentId) {
            let names: string[]
            try {
                const root = await lstat(schedulesDir(engineAgentId))
                if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(M.fileUnsafe)
                names = await readdir(schedulesDir(engineAgentId))
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
                throw error
            }
            const records = await Promise.all(names.filter(name => name.endsWith('.md')).map(name => readDefinition(engineAgentId, name.slice(0, -3))))
            return records.filter((row): row is DesktopScheduleDefinition => row !== null).sort((a, b) => a.slug.localeCompare(b.slug))
        },
        read: readDefinition,
        replace(engineAgentId, slug, expected, next, admission) {
            // Same key as schedules/loader.ts. Do not call updateScheduleAt from inside this section.
            return withKeyedLock(`schedule:${engineAgentId}:${slug}`, async () => {
                await safeDirectory(engineAgentId)
                const current = await readDefinition(engineAgentId, slug)
                if (desktopScheduleDefinitionRevision(current) !== desktopScheduleDefinitionRevision(expected)) throw new DesktopScheduleFileConflict()
                await admission?.()
                if (!next) {
                    if (current) await unlink(scheduleFile(engineAgentId, slug))
                    return null
                }
                const record: DesktopScheduleDefinition = { ...next, lastRunAt: current?.lastRunAt ?? null }
                await writeFileAtomic(scheduleFile(engineAgentId, slug), serialize(record))
                return readDefinition(engineAgentId, slug)
            })
        },
    }
}

export function memoryScheduleFiles(): DesktopScheduleFilePort & { seed(engineAgentId: string, schedule: DesktopScheduleDefinition): void } {
    const rows = new Map<string, DesktopScheduleDefinition>()
    const key = (engineAgentId: string, slug: string) => `${engineAgentId}\0${slug}`
    return {
        seed(engineAgentId, schedule) { rows.set(key(engineAgentId, schedule.slug), schedule) },
        async list(engineAgentId) {
            return [...rows.entries()].filter(([id]) => id.startsWith(`${engineAgentId}\0`)).map(([, row]) => row).sort((a, b) => a.slug.localeCompare(b.slug))
        },
        async read(engineAgentId, slug) {
            return rows.get(key(engineAgentId, slug)) ?? null
        },
        replace(engineAgentId, slug, expected, next, admission) {
            return withKeyedLock(`schedule:${engineAgentId}:${slug}`, async () => {
                const current = rows.get(key(engineAgentId, slug)) ?? null
                if (desktopScheduleDefinitionRevision(current) !== desktopScheduleDefinitionRevision(expected)) throw new DesktopScheduleFileConflict()
                await admission?.()
                if (!next) {
                    rows.delete(key(engineAgentId, slug))
                    return null
                }
                const record = { ...next, lastRunAt: current?.lastRunAt ?? null }
                rows.set(key(engineAgentId, slug), record)
                return record
            })
        },
    }
}
