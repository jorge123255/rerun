import { createClient } from '@libsql/client'
import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTriggerRequestJournal, TRIGGER_REQUEST_MIGRATION_SQL } from './journal'
import { triggerRequestKey } from './identity'
import { testTriggerLink as link } from '../../trigger-requests/fixtures.test-support'

async function setup() {
    const db = createClient({ url: 'file::memory:' })
    await db.executeMultiple(TRIGGER_REQUEST_MIGRATION_SQL)
    return { db, journal: createTriggerRequestJournal(db), key: triggerRequestKey(link) }
}
describe('durable linkage, not a duplicate request authority', () => {
    it('migration is additive and re-runnable; GET does not publish', async () => {
        const { db, journal, key } = await setup()
        try { await db.executeMultiple(TRIGGER_REQUEST_MIGRATION_SQL); expect(await journal.get(key)).toBeNull() } finally { db.close() }
    })
    it('reserves once across two instances and rejects contradictory retries', async () => {
        const { db, journal, key } = await setup()
        try {
            await journal.publish(link)
            const other = createTriggerRequestJournal(db)
            const reservations = await Promise.all([journal.reserve(key, 'same-decision'), other.reserve(key, 'same-decision')])
            expect(reservations.filter(result => result.fresh)).toHaveLength(1)
            await expect(other.reserve(key, 'different-decision')).rejects.toThrow()
            await journal.transition(key, 'accepted', 'canonical-human-run')
            expect((await other.get(key))?.acceptedRunId).toBe('canonical-human-run')
            expect((await other.transition(key, 'stopped')).phase).toBe('accepted')
        } finally { db.close() }
    })
    it('prevents source mutation and scopes copy/workspace/session isolation', async () => {
        const { db, journal } = await setup()
        try {
            await journal.publish(link)
            await expect(db.execute(`UPDATE desktop_trigger_request_links_v1 SET source_json='{}'`)).rejects.toThrow()
            expect(await journal.list({ ...link, agentId: 'copy-agent' })).toEqual([])
            expect(await journal.list({ ...link, workspaceId: 'another-workspace' })).toEqual([])
            expect(await journal.list({ ...link, engineSessionId: 'private-chat' })).toEqual([])
        } finally { db.close() }
    })
    it('never releases an accepted admission or replaces a stopped source', async () => {
        const { db, journal, key } = await setup()
        try {
            await journal.publish(link); await journal.reserve(key, 'digest'); await journal.transition(key, 'accepted', 'canonical-run')
            await expect(journal.releaseUnadmitted(key, 'digest')).rejects.toThrow()
            await expect(journal.transition(key, 'accepted', 'replacement-run')).rejects.toThrow()
        } finally { db.close() }
    })
})
