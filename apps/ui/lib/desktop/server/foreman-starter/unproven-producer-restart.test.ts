import { createClient } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createForemanStarterRepository, FOREMAN_STARTER_SQL, type StarterAuthority, type StarterBinding } from './repository'

// Negative acceptance fixture only. No current engine producer can supply this proof;
// even plausible saved metadata must never be promoted to an authoritative event.
it('unproven producer claims leave no pending request or receipt after a lost refusal and database reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unproven-starter-producer-'))
    const url = `file:${join(directory, 'fixture.db')}`
    let db = createClient({ url })
    const claimed: StarterBinding = {
        workspaceId: 'workspace-a', chatId: 'chat-a', sessionId: 'session-a', runId: 'run-a',
        turnRevision: 'turn-a', messageId: 'saved-a', toolCallId: 'call-a',
        widgetDigest: 'claimed-digest', grantRevision: 'claimed-grant',
    }
    let proofReads = 0
    const authority: StarterAuthority = {
        access: async (_, scope) => {
            if (scope.workspaceId !== claimed.workspaceId || scope.chatId !== claimed.chatId) throw new Error('foreign scope')
        },
        pending: async () => { proofReads++; return null },
    }
    const scope = { workspaceId: claimed.workspaceId, chatId: claimed.chatId }
    const decision = {
        ...scope,
        requestId: 'renderer-invented-request', revision: '1' as const,
        choice: { kind: 'text' as const, text: 'A bookkeeper' },
    }
    try {
        await db.executeMultiple(FOREMAN_STARTER_SQL)
        let repository = createForemanStarterRepository(db, authority)
        const claims: StarterBinding[] = [
            claimed,
            ...(['sessionId', 'runId', 'turnRevision', 'messageId', 'toolCallId', 'widgetDigest', 'grantRevision'] as const)
                .map(key => ({ ...claimed, [key]: `stale-${key}` })),
        ]
        // The refusal response may be lost too. Repeating publication cannot turn
        // an absent proof into a durable request, regardless of matching strings.
        for (const claim of claims) await expect(repository.publish(claim)).rejects.toThrow(/changed/)
        const beforeForeign = proofReads
        for (const scope of [{ workspaceId: 'foreign-workspace' }, { chatId: 'foreign-chat' }]) {
            await expect(repository.publish({ ...claimed, ...scope })).rejects.toThrow('foreign scope')
        }
        expect(proofReads).toBe(beforeForeign)

        db.close()
        db = createClient({ url })
        repository = createForemanStarterRepository(db, authority)
        await expect(repository.publish(claimed)).rejects.toThrow(/changed/)
        await expect(repository.decide(decision)).rejects.toThrow(/changed/)
        await expect(repository.decide(decision)).rejects.toThrow(/changed/)
        await expect(repository.decide({ ...decision, choice: { kind: 'cards', chosen: ['alpha'] } })).rejects.toThrow(/changed/)
        await expect(repository.decide({ ...decision, choice: { kind: 'dismiss' } })).rejects.toThrow(/changed/)
        expect(await repository.pending(scope)).toBeNull()
        expect(await repository.receipt(scope, decision.requestId)).toBeNull()
        for (const table of ['desktop_foreman_starter_requests', 'desktop_foreman_starter_receipts']) {
            expect((await db.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n).toBe(0)
        }
    } finally {
        db.close()
        await rm(directory, { recursive: true, force: true })
    }
})
