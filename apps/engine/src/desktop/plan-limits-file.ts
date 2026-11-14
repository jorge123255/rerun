import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planLimitsSchema, type PlanLimits } from '@rerun/contracts'
import { z } from 'zod'
import { dataDir } from '../config/paths.js'
import { keepPlanLimits } from '../connections/plan-limits.js'

const KEEP_FOR_MS = 8 * 24 * 60 * 60_000
const saved = z.record(z.string().min(1).max(256), planLimitsSchema)

/**
 * Keeps the last plan usage readings across a restart of the Mac app. Claude and Kimi only report
 * while they answer, so without this the providers list is empty after every launch until each
 * has replied again. A reading carries its capture time and the list marks an old one as such;
 * one older than the longest window (a week) is dropped. Percentages and reset times only.
 */
export function keepDesktopPlanLimits(file = join(dataDir(), 'plan-limits.json'), now = Date.now()): void {
    let readings: Record<string, PlanLimits> = {}
    try {
        const parsed = saved.safeParse(JSON.parse(readFileSync(file, 'utf8')))
        if (parsed.success) readings = Object.fromEntries(Object.entries(parsed.data).filter(([, reading]) => now - Date.parse(reading.capturedAt) < KEEP_FOR_MS))
    } catch {
        // Nothing kept yet, or a file that cannot be read: the readings start empty.
    }
    keepPlanLimits(readings, all => {
        const temp = `${file}.${randomUUID()}.tmp`
        writeFileSync(temp, JSON.stringify(all), { mode: 0o600 })
        renameSync(temp, file)
    })
}
