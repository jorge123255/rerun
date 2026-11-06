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

it('checks cancellation inside the real schedule lock and seals a no-write receipt', async () => {
    const { createClient } = await import('@libsql/client')
    const { createDesktopScheduleLifecycle, DesktopScheduleToolError } = await import('./lifecycle.js')
    const { createDesktopScheduleIntentStore } = await import('./intents.js')
    const { withKeyedLock } = await import('../../lib/lock.js')
    const { desktopScheduleDefinitionRevision } = await import('./revision.js')
    const db = createClient({ url: ':memory:' }), files = desktopScheduleFiles(), id = 'stop-lock-owner'
    const store = createDesktopScheduleIntentStore(async () => db)
    const authority = { assertActive() {}, resolveOwner: async () => ({ localAgentId: 'public', engineAgentId: id, enabled: true, deleting: false, setupPending: false, scheduleManage: true, connectedModel: { provider: 'openai', model: 'fixture' } }), readRun: async () => null }
    let entered!: () => void, release!: () => void, stopped = false
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const life = createDesktopScheduleLifecycle({ authority, store, files: { ...files, replace: async (...args) => { entered(); return files.replace(...args) } } })
    await life.create(id, { requestId: crypto.randomUUID(), name: 'Daily', description: '', body: 'Before', cron: '0 8 * * *', timezone: 'UTC' })
    const before = await files.read(id, 'daily')
    let locked!: () => void
    const acquired = new Promise<void>(resolve => { locked = resolve })
    const hold = withKeyedLock(`schedule:${id}:daily`, () => new Promise<void>(resolve => { release = resolve; locked() }))
    await acquired
    // Reset the entry barrier after the initial creation.
    const admitted = new Promise<void>(resolve => { entered = resolve })
    const input = { requestId: crypto.randomUUID(), expectedRevision: desktopScheduleDefinitionRevision(before), body: 'Must not land' }
    const guard = async () => { if (stopped) throw new DesktopScheduleToolError('cancelled', 'Cancelled at final lock') }
    const changed = life.update(id, 'daily', input, guard)
    await admitted; stopped = true; release(); await hold
    await expect(changed).rejects.toThrow('Cancelled at final lock')
    expect((await files.read(id, 'daily'))?.body).toBe('Before')
    await expect(life.update(id, 'daily', input)).rejects.toThrow('Cancelled at final lock')
    await waiting; db.close()
})

it('normalizes actual file serialization before reserving an intent and recovers a lost acknowledgement', async () => {
    const { createClient } = await import('@libsql/client')
    const { createDesktopScheduleLifecycle } = await import('./lifecycle.js')
    const { createDesktopScheduleIntentStore } = await import('./intents.js')
    const { desktopScheduleDefinitionRevision } = await import('./revision.js')
    const db = createClient({ url: ':memory:' }), files = desktopScheduleFiles(), id = 'whitespace-owner'
    const store = createDesktopScheduleIntentStore(async () => db)
    const authority = { assertActive() {}, resolveOwner: async () => ({ localAgentId: 'public', engineAgentId: id, enabled: true, deleting: false, setupPending: false, scheduleManage: true, connectedModel: { provider: 'openai', model: 'fixture' } }), readRun: async () => null }
    const initial = createDesktopScheduleLifecycle({ authority, store, files })
    await initial.create(id, { requestId: crypto.randomUUID(), name: 'Daily', description: '', body: 'Before', cron: '0 8 * * *', timezone: 'UTC' })
    const input = { requestId: crypto.randomUUID(), expectedRevision: desktopScheduleDefinitionRevision(await files.read(id, 'daily')), body: '\n  After  \n' }
    let writes = 0
    const interrupted = createDesktopScheduleLifecycle({ authority, store, files: { ...files, replace: async (...args) => { writes++; await files.replace(...args); throw new Error('ACK lost') } } })
    await expect(interrupted.update(id, 'daily', input)).rejects.toThrow('not acknowledged')
    expect((await files.read(id, 'daily'))?.body).toBe('After')
    const restored = createDesktopScheduleLifecycle({ authority, store, files })
    await restored.recover(id)
    expect((await restored.update(id, 'daily', input)).outcome).toBe('committed')
    expect(writes).toBe(1); db.close()
})
