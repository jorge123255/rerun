import { mkdtempSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-schedule-tools-'))

const { describe, expect, it } = await import('vitest')
const { desktopScheduleFiles } = await import('./files.js')
const { scheduleFile, schedulesDir } = await import('../../config/paths.js')

describe('desktop schedule definition files', () => {
    it('preserves lastRunAt across a definition swap and refuses a symlink', async () => {
        const files = desktopScheduleFiles()
        const before = { slug: 'daily', name: 'Daily', description: '', enabled: true, cron: '0 8 * * *', runAt: null, timezone: 'UTC', lastRunAt: '2026-09-29T08:00:00.000Z', connectionId: null, provider: null, model: null, body: 'digest', createdAt: '2026-09-01T00:00:00.000Z' }
        await mkdir(schedulesDir('owner'), { recursive: true })
        await writeFile(scheduleFile('owner', 'daily'), '---\nname: Daily\nenabled: true\ncron: 0 8 * * *\ntimezone: UTC\nlastRunAt: "2026-09-29T08:00:00.000Z"\ncreatedAt: "2026-09-01T00:00:00.000Z"\n---\ndigest\n')
        const current = await files.read('owner', 'daily')
        expect(current?.lastRunAt).toBe(before.lastRunAt)
        const saved = await files.replace('owner', 'daily', current, { ...current!, body: 'rewritten' })
        expect(saved).toMatchObject({ body: 'rewritten', lastRunAt: before.lastRunAt, cron: '0 8 * * *' })
        await symlink(scheduleFile('owner', 'daily'), scheduleFile('owner', 'alias'))
        await expect(files.read('owner', 'alias')).rejects.toThrow('Schedule file is not a regular file')
    })
})
