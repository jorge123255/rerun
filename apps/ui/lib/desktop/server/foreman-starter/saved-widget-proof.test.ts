import { createClient } from '@libsql/client'
import { expect, it } from 'vitest'
import { createForemanStarterRepository, FOREMAN_STARTER_SQL, type StarterBinding } from './repository'

it('saved renderer parts cannot manufacture the missing canonical starter turn/grant proof', async () => {
    const db = createClient({ url: ':memory:' })
    const claimed: StarterBinding = { workspaceId: '1', chatId: 'owned-chat', sessionId: 'claimed-session', runId: 'claimed-turn', turnRevision: '1', messageId: 'engine-claimed', toolCallId: 'claimed-call', grantRevision: 'claimed-grant', widgetDigest: 'claimed-digest' }
    // A restored tool part can contain all these strings; none is authenticated provenance.
    const saved = JSON.parse(JSON.stringify({ type: 'tool-show_starter_pack', state: 'input-available', toolCallId: claimed.toolCallId, input: { cards: [{ slug: 'alpha' }] }, metadata: claimed }))
    const authority = { access: async () => {}, pending: async () => null }
    try {
        await db.executeMultiple(FOREMAN_STARTER_SQL)
        const repository = createForemanStarterRepository(db, authority)
        await expect(repository.publish(saved.metadata)).rejects.toThrow(/changed/)
        await expect(repository.decide({ workspaceId: '1', chatId: 'owned-chat', requestId: 'renderer-invented', revision: '1', choice: { kind: 'text', text: 'A bookkeeper' } })).rejects.toThrow(/changed/)
        expect(await repository.pending({ workspaceId: '1', chatId: 'owned-chat' })).toBeNull()
        expect((await db.execute('SELECT count(*) AS n FROM desktop_foreman_starter_receipts')).rows[0]!.n).toBe(0)
        expect((await db.execute('SELECT count(*) AS n FROM desktop_foreman_starter_requests')).rows[0]!.n).toBe(0)
    } finally { db.close() }
})
