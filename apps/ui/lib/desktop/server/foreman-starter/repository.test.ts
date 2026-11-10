import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { expect, it } from 'vitest'
import { createForemanStarterRepository, FOREMAN_STARTER_SQL, starterBindingSchema, type StarterAuthority, type StarterBinding, type StarterDecision } from './repository'
const binding: StarterBinding = { workspaceId: '1', chatId: 'foreman-a', sessionId: 'session-a', runId: 'run-a', turnRevision: 'turn-1', messageId: 'saved-a', toolCallId: 'call-a', grantRevision: 'grant-1', widgetDigest: 'digest-a' }
it('one shared decision consumes text/cards/dismiss, recovers exact receipt after reopening and refuses conflicts/stale ownership', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'starter-authority-'))
    let db = createClient({ url: `file:${join(directory, 'fixture.db')}` })
    let current = binding, granted = true, stopped = false
    const authority: StarterAuthority = {
        access: async (_, scope) => { if (!granted || scope.workspaceId !== '1' || scope.chatId !== 'foreman-a') throw new Error('denied') },
        pending: async (_, target) => !stopped && JSON.stringify(starterBindingSchema.parse(target)) === JSON.stringify(current) ? { offered: ['alpha', 'beta'] } : null,
    }
    try {
        await db.executeMultiple(FOREMAN_STARTER_SQL)
        let repository = createForemanStarterRepository(db, authority)
        let request = await repository.publish(binding)
        const input: StarterDecision = { workspaceId: '1', chatId: 'foreman-a', requestId: request.requestId, revision: '1', choice: { kind: 'text', text: 'A bookkeeper' } }
        const receipt = await repository.decide(input)
        expect(receipt.output).toEqual({ answered: true, custom: 'A bookkeeper' })
        expect(receipt.continuationRequestId).toBeTruthy()
        for (const choice of [{ kind: 'dismiss' as const }, { kind: 'cards' as const, chosen: ['alpha'] }, { kind: 'text' as const, text: 'A different answer' }]) await expect(repository.decide({ ...input, choice })).rejects.toThrow(/changed/)
        db.close(); db = createClient({ url: `file:${join(directory, 'fixture.db')}` }); repository = createForemanStarterRepository(db, authority)
        stopped = true
        expect(await repository.decide(input)).toEqual(receipt)
        expect(await repository.receipt({ workspaceId: input.workspaceId, chatId: input.chatId }, input.requestId)).toEqual(receipt)
        granted = false
        await expect(repository.decide(input)).rejects.toThrow('denied')
        granted = true; stopped = false
        current = { ...binding, runId: 'run-b', toolCallId: 'call-b' }
        request = await repository.publish(current)
        await expect(repository.publish(binding)).rejects.toThrow(/changed/)
        const cards = { ...input, requestId: request.requestId, choice: { kind: 'cards' as const, chosen: ['beta', 'alpha'] } }
        await expect(repository.decide({ ...cards, choice: { kind: 'cards', chosen: ['unoffered'] } })).rejects.toThrow(/changed/)
        const chosen = await repository.decide(cards)
        expect(await repository.decide({ ...cards, choice: { kind: 'cards', chosen: ['alpha', 'beta'] } })).toEqual(chosen)
        current = { ...binding, runId: 'run-c', toolCallId: 'call-c' }; const abandoned = await repository.publish(current)
        current = { ...binding, runId: 'run-d', toolCallId: 'call-d' }; const latest = await repository.publish(current)
        await expect(repository.decide({ ...input, requestId: abandoned.requestId })).rejects.toThrow(/changed/)
        stopped = true
        await expect(repository.decide({ ...input, requestId: latest.requestId })).rejects.toThrow(/changed/)
        stopped = false
        const dismissed = await repository.decide({ ...input, requestId: latest.requestId, choice: { kind: 'dismiss' } })
        expect(dismissed.output).toEqual({ answered: false })
        expect(dismissed.continuationRequestId).toBeNull()
        await expect(repository.decide({ ...input, requestId: latest.requestId, chatId: 'other' })).rejects.toThrow('denied')
    } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})
