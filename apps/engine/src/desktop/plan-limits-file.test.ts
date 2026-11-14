import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { forgetPlanLimits, keepPlanLimits, readPlanLimits, recordPlanLimits } from '../connections/plan-limits.js'
import { keepDesktopPlanLimits } from './plan-limits-file.js'

let directory: string, file: string
const NOW = Date.parse('2026-11-14T12:00:00Z')
const window = { kind: 'weekly' as const, label: null, usedPercent: 23, resetsAt: '2026-11-16T19:49:24.473Z' }
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'rerun-plan-limits-')); file = join(directory, 'plan-limits.json') })
afterEach(() => {
    for (const id of ['kept-fixture', 'old-fixture', 'new-fixture']) forgetPlanLimits(id)
    keepPlanLimits({}, () => {})
    rmSync(directory, { recursive: true, force: true })
})

it('brings back the last readings after a restart and drops one older than a week', () => {
    writeFileSync(file, JSON.stringify({
        'kept-fixture': { windows: [window], capturedAt: '2026-11-14T09:00:00.000Z' },
        'old-fixture': { windows: [window], capturedAt: '2026-11-01T09:00:00.000Z' },
    }))
    keepDesktopPlanLimits(file, NOW)
    expect(readPlanLimits('kept-fixture')).toEqual({ windows: [window], capturedAt: '2026-11-14T09:00:00.000Z' })
    expect(readPlanLimits('old-fixture')).toBeNull()
})

it('saves each new reading and each one forgotten, privately', () => {
    keepDesktopPlanLimits(file, NOW)
    recordPlanLimits('new-fixture', [window])
    expect(JSON.parse(readFileSync(file, 'utf8'))['new-fixture'].windows).toEqual([window])
    forgetPlanLimits('new-fixture')
    expect(JSON.parse(readFileSync(file, 'utf8'))['new-fixture']).toBeUndefined()
})

it('starts empty from a file that is not readings', () => {
    writeFileSync(file, '{"kept-fixture":{"windows":"many"}}')
    keepDesktopPlanLimits(file, NOW)
    expect(readPlanLimits('kept-fixture')).toBeNull()
})
