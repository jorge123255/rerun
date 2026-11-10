import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { expect, it, vi } from 'vitest'
import { createForemanAlternateRepository, FOREMAN_ALTERNATE_SQL, type AlternateAuthority, type AlternateInput, type AlternateProof, type AlternateTarget } from './repository'
const input: AlternateInput = { workspaceId: '1', chatId: 'chat-a', requestId: '00000000-0000-4000-8000-000000000001', messageId: 'engine-reply_a', transcriptRevision: 'history-1' }
const target: AlternateProof = { workspaceId: '1', chatId: 'chat-a', sourceSessionId: 'original-session', messageId: input.messageId, sourceRunId: 'original-run', transcriptRevision: 'history-1', textDigest: 'saved-digest', precedingUserId: 'user-a', activeTurn: false, activeBuild: false, pendingDecision: false, completed: true }
it('gates unproven history, recovers only exact alternate receipts across reopening and never redispatches uncertain work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foreman-alternate-'))
    let db = createClient({ url: `file:${join(directory, 'fixture.db')}` })
    let proof: AlternateProof | null = null
    const authority: AlternateAuthority = { access: async (_, scope) => { if (scope.workspaceId !== '1' || scope.chatId !== 'chat-a') throw new Error('foreign') }, target: async () => proof }
    let saved: AlternateTarget | null = null
    const engine = { fork: vi.fn(async () => { saved = { sessionId: 'alternate-session', runId: 'alternate-run', requestId: input.requestId, sourceSessionId: target.sourceSessionId, sourceRunId: target.sourceRunId, messageId: input.messageId, transcriptRevision: input.transcriptRevision }; throw new Error('lost acknowledgement') }), lookup: vi.fn(async () => saved) }
    try {
        await db.executeMultiple(FOREMAN_ALTERNATE_SQL)
        let repository = createForemanAlternateRepository(db, authority, engine)
        await expect(repository.request(input)).rejects.toThrow(/cannot be forked/)
        for (const patch of [{ activeTurn: true }, { activeBuild: true }, { pendingDecision: true }, { completed: false }, { messageId: 'engine-other' }, { transcriptRevision: 'changed' }]) {
            proof = { ...target, ...patch }
            await expect(repository.request(input)).rejects.toThrow(/cannot be forked/)
        }
        expect(engine.fork).not.toHaveBeenCalled()
        proof = target
        expect((await repository.request(input)).state).toBe('uncertain')
        expect(engine.fork).toHaveBeenCalledTimes(1)
        db.close(); db = createClient({ url: `file:${join(directory, 'fixture.db')}` })
        repository = createForemanAlternateRepository(db, authority, engine)
        const receipt = await repository.request(input)
        expect(receipt).toMatchObject({ state: 'ready', alternate: saved, proof: target })
        expect(engine.lookup).toHaveBeenCalledTimes(1)
        expect(await repository.request(input)).toEqual(receipt)
        expect(engine.fork).toHaveBeenCalledTimes(1)
        await expect(repository.request({ ...input, messageId: 'engine-other' })).rejects.toThrow(/cannot be forked/)
        await expect(repository.request({ ...input, chatId: 'other' })).rejects.toThrow('foreign')
    } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})
