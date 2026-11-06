import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    EMPTY_DRAFT,
    type DesktopForemanChatRef,
    type DesktopForemanIntakeCompleteInput,
    type DesktopForemanIntakeCompletionAuthority,
    type DesktopForemanIntakeCompletionReceipt,
} from '@rerun/contracts'
import {
    createSqliteDesktopForemanIntakeStore,
    DesktopForemanIntakeConflictError,
    DesktopForemanIntakeRefusal,
    fingerprintIntakeAnswers,
} from './store'
import { ensureDesktopForemanIntakeSchema } from './schema'

const chat = { workspaceId: 'ws-1', chatId: 'fmc_intakesqlite01' }
const other = { workspaceId: 'ws-1', chatId: 'fmc_intakesqlite02' }
const answers = { companyUrl: 'acme.com', industry: null, decidedIndustry: null, industryLabel: null, position: 'Founder', firstName: 'Ada' }
const draft = { ...EMPTY_DRAFT, companyUrl: 'acme.com', position: 'Founder', firstName: 'Ada' }
const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
}
const followUp = { conversationId: 'existing-engine-session', runId: 'existing-foreman-run', industry: 'saas' as const }

describe('SQLite intake completion reservation and restart safety', () => {
    let directory: string
    let db: Client
    const extra: Client[] = []
    const open = () => createClient({ url: `file:${join(directory, 'app.sqlite')}` })
    const secondClient = async () => {
        const client = open(); extra.push(client)
        await client.execute('PRAGMA busy_timeout=5000')
        return client
    }
    const savedInput = async (scope: DesktopForemanChatRef = chat): Promise<DesktopForemanIntakeCompleteInput> => {
        const store = createSqliteDesktopForemanIntakeStore(db)
        const saved = await store.save({ chat: scope, requestId: randomUUID(), baseRevision: 0, stepIndex: 2, draft, decidedIndustry: null, knownFirstName: null })
        return { chat: scope, requestId: randomUUID(), expectedRevision: saved.session.revision, answers }
    }
    const authority = (): DesktopForemanIntakeCompletionAuthority => ({ lookup: vi.fn(async () => null), deliver: vi.fn(async () => followUp) })
    const seedReceipt = async (input: DesktopForemanIntakeCompleteInput, state: DesktopForemanIntakeCompletionReceipt['state'], updatedAt = '2026-11-06T00:00:00.000Z') => {
        const receipt: DesktopForemanIntakeCompletionReceipt = {
            chat: input.chat, requestId: input.requestId, fingerprint: fingerprintIntakeAnswers(input.answers, input.chat, input.requestId),
            state, answers: input.answers, followUp: null, error: null, missingAuthority: null,
            createdAt: updatedAt, updatedAt,
        }
        await db.execute({
            sql: 'INSERT INTO desktop_foreman_intake_completions(request_id,workspace_id,chat_id,fingerprint,state,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
            args: [receipt.requestId, input.chat.workspaceId, input.chat.chatId, receipt.fingerprint, state, JSON.stringify(receipt), updatedAt, updatedAt],
        })
        return receipt
    }

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'rerun-intake-completion-'))
        db = open()
        await db.executeMultiple('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
        await ensureDesktopForemanIntakeSchema(db)
    })
    afterEach(async () => {
        for (const client of extra.splice(0)) client.close()
        db.close()
        await rm(directory, { recursive: true, force: true })
    })

    it('binds the fingerprint to workspace, chat, request and normalized answers', () => {
        const requestId = randomUUID()
        const hash = fingerprintIntakeAnswers(answers, chat, requestId)
        expect(fingerprintIntakeAnswers({ ...answers, firstName: ' Ada ' }, chat, requestId)).toBe(hash)
        expect(fingerprintIntakeAnswers(answers, other, requestId)).not.toBe(hash)
        expect(fingerprintIntakeAnswers(answers, { ...chat, workspaceId: 'ws-2' }, requestId)).not.toBe(hash)
        expect(fingerprintIntakeAnswers(answers, chat, randomUUID())).not.toBe(hash)
        expect(fingerprintIntakeAnswers({ ...answers, position: 'Operations' }, chat, requestId)).not.toBe(hash)
    })

    it('refuses incomplete or stale caller answers before invoking any authority', async () => {
        const store = createSqliteDesktopForemanIntakeStore(db), bound = authority()
        const input = await savedInput()
        await expect(store.complete({ ...input, answers: { ...answers, position: 'Other role' } }, bound)).rejects.toBeInstanceOf(DesktopForemanIntakeConflictError)
        expect((await store.read(chat)).completion).toBeNull()
        await store.save({ chat, requestId: randomUUID(), baseRevision: input.expectedRevision, stepIndex: 0, draft: { ...EMPTY_DRAFT }, decidedIndustry: null, knownFirstName: null })
        await expect(store.complete({ ...input, expectedRevision: 2 }, bound)).rejects.toBeInstanceOf(DesktopForemanIntakeRefusal)
        expect(bound.lookup).not.toHaveBeenCalled()
        expect(bound.deliver).not.toHaveBeenCalled()
    })

    it('commits pending identity before effects and leaves no SQLite write transaction open during authority work', async () => {
        const input = await savedInput(), entered = deferred(), release = deferred()
        const competitor = await secondClient()
        const store = createSqliteDesktopForemanIntakeStore(db)
        const bound: DesktopForemanIntakeCompletionAuthority = {
            lookup: async () => {
                try {
                    const receipt = await createSqliteDesktopForemanIntakeStore(competitor).lookupCompletion(chat, input.requestId)
                    expect(receipt?.state).toBe('pending')
                    // A separate connection can write while an external authority is in progress.
                    await competitor.execute('CREATE TABLE unrelated_write_is_not_locked(id INTEGER)')
                } finally { entered.resolve() }
                await release.promise
                return null
            },
            deliver: async () => followUp,
        }
        const first = store.complete(input, bound)
        try {
            await entered.promise
            await expect(createSqliteDesktopForemanIntakeStore(competitor).complete({ ...input, requestId: randomUUID() }, authority())).rejects.toBeInstanceOf(DesktopForemanIntakeConflictError)
            await expect(store.save({ chat, requestId: randomUUID(), baseRevision: input.expectedRevision, stepIndex: 2, draft, decidedIndustry: null, knownFirstName: null })).rejects.toBeInstanceOf(DesktopForemanIntakeConflictError)
        } finally { release.resolve() }
        expect((await first).state).toBe('acknowledged')
    })

    it('deduplicates concurrent same-ID completions across adapters on the same database client', async () => {
        const input = await savedInput(), entered = deferred(), release = deferred()
        let delivers = 0
        const bound: DesktopForemanIntakeCompletionAuthority = {
            lookup: async () => null,
            deliver: async () => { delivers++; entered.resolve(); await release.promise; return followUp },
        }
        const first = createSqliteDesktopForemanIntakeStore(db).complete(input, bound)
        await entered.promise
        const second = createSqliteDesktopForemanIntakeStore(db).complete(input, bound)
        release.resolve()
        const result = await Promise.all([first, second])
        expect(result[0]).toEqual(result[1])
        expect(delivers).toBe(1)
    })

    it('keeps a durable pending request after reopen; read never delivers and a fresh nonce cannot bypass it', async () => {
        const input = await savedInput()
        // Crash seam: the reservation committed, but the process stopped before calling authority.
        await seedReceipt(input, 'pending')
        db.close(); db = open()
        const store = createSqliteDesktopForemanIntakeStore(db), bound = authority()
        expect((await store.read(chat)).completion?.requestId).toBe(input.requestId)
        expect((await store.lookupCompletion(chat, input.requestId))?.state).toBe('pending')
        expect(bound.deliver).not.toHaveBeenCalled()
        await expect(store.complete({ ...input, requestId: randomUUID() }, bound)).rejects.toBeInstanceOf(DesktopForemanIntakeConflictError)
        expect((await store.complete(input, bound)).state).toBe('acknowledged')
        expect(bound.deliver).toHaveBeenCalledTimes(1)
    })

    it('recovers delivery with a lost ACK after a real database reopen using the original request only', async () => {
        const input = await savedInput()
        let admitted: Parameters<DesktopForemanIntakeCompletionAuthority['deliver']>[0] | null = null
        const bound: DesktopForemanIntakeCompletionAuthority = {
            lookup: vi.fn(async identity => admitted ? { ...identity, ...followUp } : null),
            deliver: vi.fn(async identity => { admitted = identity; throw new Error('secret provider body '.repeat(100)) }),
        }
        const receipt = await createSqliteDesktopForemanIntakeStore(db).complete(input, bound)
        expect(receipt.state).toBe('uncertain')
        expect(receipt.error).not.toContain('secret')
        db.close(); db = open()
        const reopened = createSqliteDesktopForemanIntakeStore(db)
        expect((await reopened.read(chat)).completion).toEqual(receipt)
        await expect(reopened.complete({ ...input, requestId: randomUUID() }, bound)).rejects.toBeInstanceOf(DesktopForemanIntakeConflictError)
        const recovered = await reopened.complete(input, bound)
        expect(recovered.state).toBe('acknowledged')
        expect(recovered.requestId).toBe(input.requestId)
        expect(recovered.followUp).toEqual(followUp)
        expect(bound.deliver).toHaveBeenCalledTimes(1)
    })

    it('does not deliver after an unknown lookup or accept another chat identity as recovery', async () => {
        const input = await savedInput()
        const bound = authority()
        bound.lookup = vi.fn(async () => { throw new Error('engine unavailable') })
        const store = createSqliteDesktopForemanIntakeStore(db)
        expect((await store.complete(input, bound)).state).toBe('uncertain')
        expect(bound.deliver).not.toHaveBeenCalled()
        bound.lookup = vi.fn(async identity => ({ ...identity, chat: other, ...followUp }))
        expect((await store.complete(input, bound)).state).toBe('uncertain')
        expect(bound.deliver).not.toHaveBeenCalled()
    })

    it('treats legacy failed receipts as ambiguous and requires recovery with their original identity', async () => {
        const input = await savedInput()
        await seedReceipt(input, 'failed')
        const store = createSqliteDesktopForemanIntakeStore(db), bound = authority()
        await expect(store.complete({ ...input, requestId: randomUUID() }, bound)).rejects.toBeInstanceOf(DesktopForemanIntakeConflictError)
        bound.lookup = vi.fn(async identity => ({ ...identity, ...followUp }))
        expect((await store.complete(input, bound)).state).toBe('acknowledged')
        expect(bound.deliver).not.toHaveBeenCalled()
    })

    it('fences simultaneous same-ID requests for different chats and never overwrites indexed identity', async () => {
        const first = await savedInput(chat), second = { ...await savedInput(other), requestId: first.requestId }
        const rival = await secondClient(), bound = authority()
        const outcomes = await Promise.allSettled([
            createSqliteDesktopForemanIntakeStore(db).complete(first, bound),
            createSqliteDesktopForemanIntakeStore(rival).complete(second, bound),
        ])
        expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        const row = (await db.execute({ sql: 'SELECT workspace_id,chat_id,fingerprint,body FROM desktop_foreman_intake_completions WHERE request_id=?', args: [first.requestId] })).rows[0]!
        const receipt = JSON.parse(String(row.body)) as DesktopForemanIntakeCompletionReceipt
        expect(receipt.chat).toEqual({ workspaceId: String(row.workspace_id), chatId: String(row.chat_id) })
        expect(receipt.fingerprint).toBe(String(row.fingerprint))
        const losingChat = receipt.chat.chatId === chat.chatId ? other : chat
        expect(await createSqliteDesktopForemanIntakeStore(db).lookupCompletion(losingChat, first.requestId)).toBeNull()
        expect(bound.deliver).toHaveBeenCalledTimes(1)
    })

    it('keeps acknowledgement permanent even if a newer historical failure exists', async () => {
        const input = await savedInput(), store = createSqliteDesktopForemanIntakeStore(db), bound = authority()
        const acknowledged = await store.complete(input, bound)
        const historical = { ...input, requestId: randomUUID() }
        await seedReceipt(historical, 'failed', '2099-01-01T00:00:00.000Z')
        expect((await store.read(chat)).completion).toEqual(acknowledged)
        expect(await store.complete(input, bound)).toEqual(acknowledged)
        await expect(store.complete({ ...input, requestId: randomUUID() }, bound)).rejects.toBeInstanceOf(DesktopForemanIntakeConflictError)
        await expect(store.complete(historical, bound)).rejects.toBeInstanceOf(DesktopForemanIntakeConflictError)
        await expect(store.save({ chat, requestId: randomUUID(), baseRevision: input.expectedRevision, stepIndex: 2, draft, decidedIndustry: null, knownFirstName: null })).rejects.toBeInstanceOf(DesktopForemanIntakeConflictError)
        expect(bound.deliver).toHaveBeenCalledTimes(1)
    })

    it('allows answers to change only after definitely unavailable completion, without changing its receipt', async () => {
        const input = await savedInput(), store = createSqliteDesktopForemanIntakeStore(db)
        expect((await store.complete(input, null)).state).toBe('unavailable')
        await store.save({ chat, requestId: randomUUID(), baseRevision: input.expectedRevision, stepIndex: 2, draft: { ...draft, position: 'Operations' }, decidedIndustry: null, knownFirstName: null })
        const bound = authority()
        const changed = { ...input, requestId: randomUUID(), expectedRevision: 2, answers: { ...answers, position: 'Operations' } }
        expect((await store.complete(changed, bound)).state).toBe('acknowledged')
        expect((await store.lookupCompletion(chat, input.requestId))?.state).toBe('unavailable')
    })

    it.each(['fingerprint', 'state', 'chat_id', 'workspace_id', 'updated_at'] as const)('fails closed when completion column %s disagrees with its body', async column => {
        const input = await savedInput()
        await seedReceipt(input, 'pending')
        // Column names come exclusively from the fixed test cases above.
        await db.execute({ sql: `UPDATE desktop_foreman_intake_completions SET ${column}=? WHERE request_id=?`, args: ['corrupt-column', input.requestId] })
        const store = createSqliteDesktopForemanIntakeStore(db), bound = authority()
        await expect(store.lookupCompletion(chat, input.requestId)).rejects.toMatchObject({ status: 503 })
        await expect(store.complete(input, bound)).rejects.toMatchObject({ status: 503 })
        expect(bound.lookup).not.toHaveBeenCalled()
        expect(bound.deliver).not.toHaveBeenCalled()
    })

    it('cannot acknowledge or overwrite a reserved receipt corrupted while delivery is in flight', async () => {
        const input = await savedInput(), store = createSqliteDesktopForemanIntakeStore(db)
        const bound: DesktopForemanIntakeCompletionAuthority = {
            lookup: async () => null,
            deliver: async () => {
                await db.execute({ sql: 'UPDATE desktop_foreman_intake_completions SET fingerprint=? WHERE request_id=?', args: ['changed-during-authority', input.requestId] })
                return followUp
            },
        }
        await expect(store.complete(input, bound)).rejects.toMatchObject({ status: 503 })
        const row = (await db.execute({ sql: 'SELECT state,fingerprint,body FROM desktop_foreman_intake_completions WHERE request_id=?', args: [input.requestId] })).rows[0]!
        expect(row.state).toBe('pending')
        expect(row.fingerprint).toBe('changed-during-authority')
        expect((JSON.parse(String(row.body)) as DesktopForemanIntakeCompletionReceipt).state).toBe('pending')
    })
})
