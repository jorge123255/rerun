import { createClient } from '@libsql/client'
import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_SCHEDULE_TOOL_MESSAGES as M } from '@rerun/contracts'
import { isDue } from '../../schedules/cron.js'
import { createDesktopScheduleIntentStore } from './intents.js'
import { createDesktopScheduleLifecycle, DesktopScheduleToolError } from './lifecycle.js'
import { memoryScheduleFiles } from './files.js'
import { desktopScheduleDefinitionRevision } from './revision.js'
import type { DesktopScheduleDefinition, DesktopScheduleFilePort, DesktopScheduleOwner } from './types.js'

const NOW = new Date('2026-09-30T06:00:00.000Z')

function definition(patch: Partial<DesktopScheduleDefinition> & Pick<DesktopScheduleDefinition, 'slug' | 'name' | 'body'>): DesktopScheduleDefinition {
    return {
        description: '', enabled: true, cron: null, runAt: null, timezone: 'UTC', lastRunAt: null,
        connectionId: null, provider: null, model: null, createdAt: NOW.toISOString(), ...patch,
    }
}

function harness() {
    const files = memoryScheduleFiles()
    const client = createClient({ url: ':memory:' })
    const store = createDesktopScheduleIntentStore(async () => client)
    const notify = vi.fn(async () => {})
    const owner: DesktopScheduleOwner = {
        localAgentId: 'local-1', engineAgentId: 'eng-1', enabled: true, deleting: false, setupPending: false,
        scheduleManage: true, connectedModel: { provider: 'openai', model: 'gpt-5' },
    }
    let writes = 0
    const port: DesktopScheduleFilePort = {
        list: files.list.bind(files),
        read: files.read.bind(files),
        replace: async (agent, slug, expected, next) => { writes += 1; return files.replace(agent, slug, expected, next) },
    }
    const lifecycle = createDesktopScheduleLifecycle({
        authority: { assertActive() {}, resolveOwner: async () => owner, readRun: async () => ({ agentId: 'eng-1', sessionId: 'session-1', status: 'running' }), notify },
        files: port, store, now: () => NOW,
    })
    return { files, store, notify, owner, lifecycle, writes: () => writes }
}

const created = { requestId: '00000000-0000-4000-8000-000000000001', name: 'Weekly report', description: 'Report every Monday', body: 'Write the report.', cron: '0 9 * * 1', timezone: 'UTC' }

describe('desktop schedule tool lifecycle', () => {
    it('lists an empty coworker and does not publish or write', async () => {
        const { lifecycle, notify, writes } = harness()
        expect((await lifecycle.list('eng-1')).text).toBe(M.empty)
        expect(notify).not.toHaveBeenCalled()
        expect(writes()).toBe(0)
    })

    it('lists recurring, one-shot, paused and already-fired tasks without running them', async () => {
        const { files, lifecycle, writes } = harness()
        files.seed('eng-1', definition({ slug: 'morning-digest', name: 'Morning digest', body: 'digest', cron: '*/15 * * * *' }))
        files.seed('eng-1', definition({ slug: 'call-the-bank', name: 'Call the bank', body: 'call', runAt: '2026-10-02T09:00:00.000Z' }))
        files.seed('eng-1', definition({ slug: 'paused-sync', name: 'Paused sync', body: 'sync', cron: '*/5 * * * *', enabled: false }))
        files.seed('eng-1', definition({ slug: 'fired', name: 'Fired', body: 'body', runAt: '2026-09-01T00:00:00.000Z', lastRunAt: '2026-09-01T00:00:05.000Z' }))
        expect((await lifecycle.list('eng-1')).text.split('\n')).toEqual([
            '- Call the bank (call-the-bank): once 2026-10-02T09:00:00.000Z, next 2026-10-02T09:00:00.000Z',
            '- Fired (fired): once 2026-09-01T00:00:00.000Z, next never',
            '- Morning digest (morning-digest): cron */15 * * * *, next 2026-09-30T06:15:00.000Z',
            '- Paused sync (paused-sync): cron */5 * * * *, disabled',
        ])
        expect(writes()).toBe(0)
    })

    it('reads a full body and revision and reports a missing slug', async () => {
        const { files, lifecycle } = harness()
        files.seed('eng-1', definition({ slug: 'off', name: 'Off', body: 'noop', cron: '0 * * * *', enabled: false, model: 'gpt-5' }))
        const receipt = await lifecycle.get('eng-1', 'off')
        expect(receipt.text).toBe(['Off (off)', 'Cron: 0 * * * *', 'Timezone: UTC', 'Enabled: false', `Revision: ${receipt.revision}`, 'Model: gpt-5', 'noop'].join('\n'))
        await expect(lifecycle.get('eng-1', 'ghost')).rejects.toThrow(M.notFound('ghost'))
    })

    it('stays committed when the panel notice fails and does not write again', async () => {
        const box = harness()
        box.notify.mockImplementationOnce(async () => { throw new Error('panel down') })
        const receipt = await box.lifecycle.create('eng-1', created)
        expect(receipt.outcome).toBe('committed')
        expect(await box.files.read('eng-1', 'weekly-report')).toMatchObject({ body: 'Write the report.' })
        expect(await box.lifecycle.create('eng-1', created)).toEqual(receipt)
        expect(box.writes()).toBe(1)
        expect(box.notify).toHaveBeenCalledTimes(1)
    })

    it('creates a follow-coworker routine and replays the same request without a second write', async () => {
        const { lifecycle, files, notify, writes } = harness()
        const first = await lifecycle.create('eng-1', created)
        expect(first.text).toBe(M.created('weekly-report'))
        expect(await files.read('eng-1', 'weekly-report')).toMatchObject({ cron: '0 9 * * 1', runAt: null, timezone: 'UTC', connectionId: null, provider: null, model: null, enabled: true })
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ operation: 'create', outcome: 'committed', slug: 'weekly-report' }))
        const replay = await lifecycle.create('eng-1', created)
        expect(replay).toEqual(first)
        expect(writes()).toBe(1)
    })

    it('refuses missing, duplicate, invalid and natural-language timing without saving', async () => {
        const { lifecycle, files } = harness()
        const base = { requestId: '00000000-0000-4000-8000-000000000010', name: 'Weekly report', description: '', body: 'Write.' }
        await expect(lifecycle.create('eng-1', base)).rejects.toThrow(M.neither)
        await expect(lifecycle.create('eng-1', { ...base, cron: '0 9 * * 1', runAt: '2026-10-05T09:00:00.000Z' })).rejects.toThrow(M.both)
        await expect(lifecycle.create('eng-1', { ...base, cron: 'every monday', timezone: 'UTC' })).rejects.toThrow(M.invalidCron('every monday'))
        await expect(lifecycle.create('eng-1', { ...base, requestId: '00000000-0000-4000-8000-000000000011', runAt: 'next monday', timezone: 'UTC' })).rejects.toThrow(M.invalidRunAt('next monday'))
        await expect(lifecycle.create('eng-1', { ...base, cron: '0 9 * * 1' })).rejects.toThrow(M.timezone)
        await expect(lifecycle.create('eng-1', { ...base, cron: '0 9 * * 1', timezone: 'Not/AZone' })).rejects.toThrow(M.invalidTimezone('Not/AZone'))
        expect(await files.list('eng-1')).toEqual([])
    })

    it('refuses a different model pin and a coworker with no connected model', async () => {
        const box = harness()
        await expect(box.lifecycle.create('eng-1', { ...created, requestId: '00000000-0000-4000-8000-000000000020', provider: 'google', model: 'gemini-2.5-pro' })).rejects.toThrow(M.pinIgnored('openai/gpt-5'))
        box.owner.connectedModel = null
        await expect(box.lifecycle.create('eng-1', { ...created, requestId: '00000000-0000-4000-8000-000000000021' })).rejects.toThrow(M.noModel)
        expect(await box.files.list('eng-1')).toEqual([])
    })

    it('stores a matching pin as follow-coworker and ignores a lone provider on create', async () => {
        const { lifecycle, files } = harness()
        await lifecycle.create('eng-1', { ...created, provider: 'openai', model: 'gpt-5' })
        expect(await files.read('eng-1', 'weekly-report')).toMatchObject({ provider: null, model: null, connectionId: null })
        const second = harness()
        await second.lifecycle.create('eng-1', { ...created, provider: 'claude' })
        expect(await second.files.read('eng-1', 'weekly-report')).toMatchObject({ provider: null, model: null })
    })

    it('rejects a second name and keeps the first routine', async () => {
        const { lifecycle, files } = harness()
        await lifecycle.create('eng-1', created)
        await expect(lifecycle.create('eng-1', { ...created, requestId: '00000000-0000-4000-8000-000000000030', body: 'Other.' })).rejects.toThrow(M.exists)
        expect((await files.read('eng-1', 'weekly-report'))?.body).toBe('Write the report.')
    })

    it('replaces the whole body only through update, and switches cron and runAt exclusively', async () => {
        const { lifecycle, files } = harness()
        await lifecycle.create('eng-1', created)
        const current = await files.read('eng-1', 'weekly-report')
        const revision = desktopScheduleDefinitionRevision(current)
        const replaced = await lifecycle.update('eng-1', 'weekly-report', { requestId: '00000000-0000-4000-8000-000000000040', expectedRevision: revision, body: 'A full rewrite.' })
        expect(replaced.text).toBe(M.replacedBody('weekly-report', current!.body.length, 'A full rewrite.'.length))
        const switched = await lifecycle.update('eng-1', 'weekly-report', { requestId: '00000000-0000-4000-8000-000000000041', expectedRevision: desktopScheduleDefinitionRevision(await files.read('eng-1', 'weekly-report')), runAt: '2026-10-05T09:00:00.000Z' })
        expect(switched.outcome).toBe('committed')
        expect(await files.read('eng-1', 'weekly-report')).toMatchObject({ cron: null, runAt: '2026-10-05T09:00:00.000Z', body: 'A full rewrite.' })
    })

    it('rejects a stale or ambiguous edit and keeps the previous routine', async () => {
        const { lifecycle, files } = harness()
        files.seed('eng-1', definition({ slug: 'digest', name: 'Digest', body: 'Check inbox. Summarize inbox.', cron: '0 8 * * *' }))
        const revision = desktopScheduleDefinitionRevision(await files.read('eng-1', 'digest'))
        await expect(lifecycle.update('eng-1', 'digest', { requestId: '00000000-0000-4000-8000-000000000050', expectedRevision: 'stale', description: 'Later' })).rejects.toThrow(M.stale)
        await expect(lifecycle.edit('eng-1', 'digest', { requestId: '00000000-0000-4000-8000-000000000051', expectedRevision: revision, oldString: 'inbox', newString: 'mailbox', replaceAll: false })).rejects.toThrow(M.ambiguous('digest', 2))
        await expect(lifecycle.edit('eng-1', 'digest', { requestId: '00000000-0000-4000-8000-000000000052', expectedRevision: revision, oldString: 'inbox', newString: 'inbox', replaceAll: false })).rejects.toThrow(M.identical)
        expect(await files.read('eng-1', 'digest')).toMatchObject({ body: 'Check inbox. Summarize inbox.', description: '' })
    })

    it('edits one exact excerpt and preserves a fired one-shot stamp', async () => {
        const { lifecycle, files } = harness()
        files.seed('eng-1', definition({ slug: 'digest', name: 'Digest', body: 'Check inbox.', cron: '0 8 * * *', lastRunAt: '2026-09-29T08:00:00.000Z', enabled: false }))
        const revision = desktopScheduleDefinitionRevision(await files.read('eng-1', 'digest'))
        const edited = await lifecycle.edit('eng-1', 'digest', { requestId: '00000000-0000-4000-8000-000000000060', expectedRevision: revision, oldString: 'inbox', newString: 'mailbox', replaceAll: false })
        expect(edited.text).toBe(M.edited('digest', 1))
        const saved = await files.read('eng-1', 'digest')
        expect(saved).toMatchObject({ body: 'Check mailbox.', lastRunAt: '2026-09-29T08:00:00.000Z', enabled: false, cron: '0 8 * * *' })
        expect(isDue(saved!, NOW)).toBe(false)
    })

    it('does not let a human edit lose to a stale model replacement', async () => {
        const { lifecycle, files } = harness()
        files.seed('eng-1', definition({ slug: 'digest', name: 'Digest', body: 'digest', cron: '0 8 * * *' }))
        const seen = desktopScheduleDefinitionRevision(await files.read('eng-1', 'digest'))
        const human = { ...(await files.read('eng-1', 'digest'))!, body: 'human saved this' }
        await files.replace('eng-1', 'digest', await files.read('eng-1', 'digest'), human)
        await expect(lifecycle.update('eng-1', 'digest', { requestId: '00000000-0000-4000-8000-000000000070', expectedRevision: seen, body: 'model overwrite' })).rejects.toThrow(M.stale)
        expect((await files.read('eng-1', 'digest'))?.body).toBe('human saved this')
    })

    it('deletes the definition and leaves an external run history untouched', async () => {
        const { lifecycle, files } = harness()
        files.seed('eng-1', definition({ slug: 'digest', name: 'Digest', body: 'digest', cron: '0 8 * * *' }))
        const history = [{ runId: 'run-kept', slug: 'digest' }]
        const revision = desktopScheduleDefinitionRevision(await files.read('eng-1', 'digest'))
        expect((await lifecycle.remove('eng-1', 'digest', { requestId: '00000000-0000-4000-8000-000000000080', expectedRevision: revision })).text).toBe(M.deleted('digest'))
        expect(await files.read('eng-1', 'digest')).toBeNull()
        expect(history).toEqual([{ runId: 'run-kept', slug: 'digest' }])
    })

    it('rejects a reused request that changes shape', async () => {
        const { lifecycle } = harness()
        await lifecycle.create('eng-1', created)
        await expect(lifecycle.create('eng-1', { ...created, body: 'Different.' })).rejects.toThrow(M.conflict)
    })

    it('reconciles a lost acknowledgement without writing the routine twice', async () => {
        const box = harness()
        const real = box.store.complete.bind(box.store)
        let failed = false
        box.store.complete = async (agent, request, json) => {
            if (!failed) { failed = true; throw new Error('lost acknowledgement') }
            await real(agent, request, json)
        }
        await expect(box.lifecycle.create('eng-1', created)).rejects.toThrow('lost acknowledgement')
        expect(await box.files.read('eng-1', 'weekly-report')).toMatchObject({ body: 'Write the report.' })
        const replay = await box.lifecycle.create('eng-1', created)
        expect(replay.text).toBe(M.created('weekly-report'))
        expect(box.writes()).toBe(1)
    })

    it('recovers a landed write, leaves an unlanded write pending, and does not replay a one-shot', async () => {
        const box = harness()
        const real = box.store.complete.bind(box.store)
        box.store.complete = async () => { throw new Error('restart') }
        await expect(box.lifecycle.create('eng-1', { ...created, runAt: '2026-01-01T00:00:00.000Z', cron: undefined })).rejects.toThrow('restart')
        const fired = await box.files.read('eng-1', 'weekly-report')
        expect(fired).toMatchObject({ runAt: '2026-01-01T00:00:00.000Z', lastRunAt: null, enabled: true })
        expect(isDue(fired!, NOW)).toBe(true)
        box.store.complete = real
        expect(await box.lifecycle.recover('eng-1')).toEqual({ reconciled: 1, waiting: 0, interrupted: 0 })
        expect((await box.files.read('eng-1', 'weekly-report'))?.lastRunAt).toBeNull()
        const pending = harness()
        pending.files.replace = async () => { throw new Error('disk') }
        await expect(pending.lifecycle.create('eng-1', { ...created, requestId: '00000000-0000-4000-8000-000000000090' })).rejects.toThrow(M.uncertain)
        expect(await pending.lifecycle.recover('eng-1')).toEqual({ reconciled: 0, waiting: 1, interrupted: 0 })
        expect(await pending.files.read('eng-1', 'weekly-report')).toBeNull()
    })

    it('interrupts a pending write when a person replaced the routine during the gap', async () => {
        const box = harness()
        const real = box.store.complete.bind(box.store)
        box.store.complete = async () => { throw new Error('restart') }
        await expect(box.lifecycle.create('eng-1', created)).rejects.toThrow('restart')
        const current = await box.files.read('eng-1', 'weekly-report')
        await box.files.replace('eng-1', 'weekly-report', current, { ...current!, body: 'person kept this' })
        box.store.complete = real
        expect(await box.lifecycle.recover('eng-1')).toEqual({ reconciled: 0, waiting: 0, interrupted: 1 })
        expect((await box.files.read('eng-1', 'weekly-report'))?.body).toBe('person kept this')
        await expect(box.lifecycle.create('eng-1', created)).rejects.toThrow(M.interrupted)
        expect((await box.files.read('eng-1', 'weekly-report'))?.body).toBe('person kept this')
    })

    it('refuses management when the grant, setup, or coworker state changes', async () => {
        const box = harness()
        box.owner.scheduleManage = false
        await expect(box.lifecycle.create('eng-1', created)).rejects.toThrow(M.permission)
        box.owner.scheduleManage = true
        box.owner.setupPending = true
        await expect(box.lifecycle.list('eng-1')).rejects.toThrow(M.setup)
        box.owner.setupPending = false
        box.owner.enabled = false
        await expect(box.lifecycle.list('eng-1')).rejects.toThrow(M.disabled)
        box.owner.enabled = true
        box.owner.deleting = true
        await expect(box.lifecycle.list('eng-1')).rejects.toThrow(M.deleting)
        expect(await box.files.list('eng-1')).toEqual([])
    })

    it('seals a stopped parent before the write and does not commit it later', async () => {
        const box = harness()
        let calls = 0
        await expect(box.lifecycle.create('eng-1', created, async () => {
            calls += 1
            if (calls > 1) throw new DesktopScheduleToolError('rejected', M.inactive)
        })).rejects.toThrow(M.inactive)
        expect(await box.files.read('eng-1', 'weekly-report')).toBeNull()
        await expect(box.lifecycle.create('eng-1', created)).rejects.toThrow(M.inactive)
        expect(await box.files.read('eng-1', 'weekly-report')).toBeNull()
    })

    it('keeps a terminal receipt immutable', async () => {
        const box = harness()
        await box.lifecycle.create('eng-1', created)
        const saved = await box.store.findIntent('eng-1', created.requestId)
        await box.store.complete('eng-1', created.requestId, JSON.stringify({ outcome: 'committed', text: 'changed' }))
        expect(await box.store.findIntent('eng-1', created.requestId)).toEqual(saved)
    })

    it('seals a cancelled admission without saving', async () => {
        const box = harness()
        let calls = 0
        await expect(box.lifecycle.create('eng-1', { ...created, requestId: '00000000-0000-4000-8000-0000000000b0' }, async () => {
            calls += 1
            if (calls > 1) throw new DesktopScheduleToolError('cancelled', M.cancelled)
        })).rejects.toMatchObject({ outcome: 'cancelled' })
        expect(await box.files.read('eng-1', 'weekly-report')).toBeNull()
        await expect(box.lifecycle.create('eng-1', { ...created, requestId: '00000000-0000-4000-8000-0000000000b0' })).rejects.toMatchObject({ outcome: 'cancelled' })
    })

    it('refuses a provider named without a model and leaves the routine untouched', async () => {
        const { lifecycle, files } = harness()
        files.seed('eng-1', definition({ slug: 'digest', name: 'Digest', body: 'digest', cron: '0 8 * * *', provider: 'openai', model: 'gpt-5' }))
        await expect(lifecycle.update('eng-1', 'digest', { requestId: '00000000-0000-4000-8000-0000000000a0', expectedRevision: desktopScheduleDefinitionRevision(await files.read('eng-1', 'digest')), provider: 'claude', description: 'Later' })).rejects.toThrow(M.providerWithoutModel)
        expect(await files.read('eng-1', 'digest')).toMatchObject({ description: '', provider: 'openai', model: 'gpt-5' })
    })
})
