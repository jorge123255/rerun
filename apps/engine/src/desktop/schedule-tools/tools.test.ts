import { createClient } from '@libsql/client'
import { describe, expect, it } from 'vitest'
import { DESKTOP_SCHEDULE_TOOL_MESSAGES as M } from '@rerun/contracts'
import { createDesktopScheduleLifecycle } from './lifecycle.js'
import { createDesktopScheduleIntentStore } from './intents.js'
import { memoryScheduleFiles } from './files.js'
import { createDesktopScheduleToolFactory } from './tools.js'
import type { DesktopScheduleOwner, DesktopScheduleRun } from './types.js'

const NOW = new Date('2026-09-30T06:00:00.000Z')

function factory(patch: Partial<DesktopScheduleOwner> = {}, run?: Partial<DesktopScheduleRun>) {
    const files = memoryScheduleFiles()
    const client = createClient({ url: ':memory:' })
    const store = createDesktopScheduleIntentStore(async () => client)
    const owner: DesktopScheduleOwner = {
        localAgentId: 'local-1', engineAgentId: 'eng-1', enabled: true, deleting: false, setupPending: false,
        scheduleManage: true, connectedModel: { provider: 'openai', model: 'gpt-5' }, ...patch,
    }
    const current: DesktopScheduleRun = { agentId: 'eng-1', sessionId: 'session-1', status: 'running', ...run }
    const authority = {
        assertActive() {},
        resolveOwner: async () => owner,
        readRun: async () => current,
        notify: async () => {},
    }
    const lifecycle = createDesktopScheduleLifecycle({ authority, files, store, now: () => NOW })
    const tools = createDesktopScheduleToolFactory({ authority, lifecycle, store }).tools('eng-1', { runId: 'run-1', sessionId: 'session-1' })
    const call = async (name: keyof typeof tools, input: unknown, toolCallId = 'call-1') => (tools[name] as { execute: (value: never, options: { toolCallId: string }) => Promise<string> }).execute(input as never, { toolCallId })
    return { files, owner, current, call }
}

describe('desktop schedule tools', () => {
    it('returns the original created line and does not run the routine', async () => {
        const { files, call } = factory()
        expect(await call('schedule_create', { name: 'Weekly report', description: 'Report every Monday', body: 'Write the report.', cron: '0 9 * * 1', timezone: 'UTC' })).toBe('Created schedule weekly-report')
        expect(await files.read('eng-1', 'weekly-report')).toMatchObject({ lastRunAt: null, enabled: true })
        expect(await call('schedule_list', {}, 'call-2')).toContain('Weekly report (weekly-report)')
    })

    it('replays one tool call and rejects a changed retry', async () => {
        const { call, files } = factory()
        await call('schedule_create', { name: 'Weekly report', description: '', body: 'Write the report.', cron: '0 9 * * 1', timezone: 'UTC' }, 'same')
        expect(await call('schedule_create', { name: 'Weekly report', description: '', body: 'Write the report.', cron: '0 9 * * 1', timezone: 'UTC' }, 'same')).toBe('Created schedule weekly-report')
        expect(await call('schedule_create', { name: 'Weekly report', description: '', body: 'Changed.', cron: '0 9 * * 1', timezone: 'UTC' }, 'same')).toBe(M.conflict)
        expect((await files.read('eng-1', 'weekly-report'))?.body).toBe('Write the report.')
    })

    it('returns a refusal when schedule management is off or the parent run has stopped', async () => {
        const off = factory({ scheduleManage: false })
        expect(await off.call('schedule_list', {})).toBe(M.permission)
        const stopped = factory({}, { status: 'cancelled' })
        expect(await stopped.call('schedule_create', { name: 'Weekly report', description: '', body: 'Write.', cron: '0 9 * * 1', timezone: 'UTC' })).toBe(M.inactive)
        expect(await stopped.files.read('eng-1', 'weekly-report')).toBeNull()
    })

    it('edits an exact string and refuses an ambiguous one', async () => {
        const { files, call } = factory()
        files.seed('eng-1', { slug: 'digest', name: 'Digest', description: '', body: 'Check inbox.', enabled: true, cron: '0 8 * * *', runAt: null, timezone: 'UTC', lastRunAt: null, connectionId: null, provider: null, model: null, createdAt: NOW.toISOString() })
        const read = await call('schedule_get', { slug: 'digest' }, 'get')
        const revision = read.split('\n').find(line => line.startsWith('Revision: '))?.slice('Revision: '.length)
        expect(await call('schedule_edit', { slug: 'digest', expectedRevision: revision, oldString: 'inbox', newString: 'mailbox', replaceAll: false }, 'edit')).toBe('Edited schedule digest (1 replacement)')
        expect(await call('schedule_edit', { slug: 'digest', expectedRevision: (await call('schedule_get', { slug: 'digest' }, 'again')).split('Revision: ')[1]?.split('\n')[0], oldString: 'nope', newString: 'x', replaceAll: false }, 'miss')).toBe(M.missingExcerpt('digest'))
    })
})

it('does not adopt a new revision when the model omits it after a human edit', async () => {
    const box = factory()
    await box.call('schedule_create', { name: 'Daily', description: '', body: 'Original', cron: '0 8 * * *', timezone: 'UTC' }, 'create')
    const original = (await box.files.read('eng-1', 'daily'))!
    await box.files.replace('eng-1', 'daily', original, { ...original, body: 'Human saved' })
    expect(await box.call('schedule_update', { slug: 'daily', body: 'Old model replacement' }, 'stale')).toBe(M.stale)
    expect(await box.call('schedule_delete', { slug: 'daily' }, 'delete')).toBe(M.stale)
    expect((await box.files.read('eng-1', 'daily'))?.body).toBe('Human saved')
})
it('rejects a retry that changes only its originally supplied revision', async () => {
    const box = factory()
    await box.call('schedule_create', { name: 'Daily', description: '', body: 'Original', cron: '0 8 * * *', timezone: 'UTC' }, 'create')
    const revision = (await box.call('schedule_get', { slug: 'daily' }, 'read')).split('Revision: ')[1]!.split('\n')[0]
    const input = { slug: 'daily', expectedRevision: revision, body: 'Replacement' }
    expect(await box.call('schedule_update', input, 'update')).toContain('Updated schedule daily')
    expect(await box.call('schedule_update', { ...input, expectedRevision: 'f'.repeat(64) }, 'update')).toBe(M.conflict)
})
