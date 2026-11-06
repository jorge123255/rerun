import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopSecretCrypto } from './crypto'
import { ensureDesktopSecretRequestSchema } from './schema'
import { createDesktopSecretRequestStore, type DesktopSecretRequestStore } from './store'
import type { DesktopSecretRequestDecision, DesktopSecretRequestRecovery, DesktopSecretRequestSource } from '@rerun/contracts'

let directory: string
let db: Client
let store: DesktopSecretRequestStore
const crypto = createDesktopSecretCrypto(() => Buffer.alloc(32, 7))
const source: DesktopSecretRequestSource = { agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint' }
const fields = [{ key: 'EXAMPLE_API_KEY', label: 'Example API key' }, { key: 'OTHER_TOKEN', label: 'Other token' }]
const allow = { check: () => {} }

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rerun-secret-qa-'))
    db = createClient({ url: `file:${join(directory, 'test.sqlite')}` })
    await db.executeMultiple("CREATE TABLE desktop_agents (id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT); INSERT INTO desktop_agents VALUES('agent'); INSERT INTO desktop_sessions VALUES('chat','agent');")
    await ensureDesktopSecretRequestSchema(db)
    store = createDesktopSecretRequestStore(db, crypto)
    await store.publish({ source, fields, reason: 'Use the API.' })
})
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

const decision = (operation: DesktopSecretRequestDecision['operation'] = 'save'): DesktopSecretRequestDecision => ({
    operation, requestId: 'request', attemptId: 'attempt', expectedRevision: 'revision', source,
    ...(operation === 'save' ? { values: { EXAMPLE_API_KEY: '  exact bytes\r\n' } } : {}),
})

async function publish() {
    const view = await store.readBySource(source)
    return { ...decision(), requestId: view!.requestId, expectedRevision: view!.revision }
}

test('Save preserves exact bytes, seals at rest and returns only names/presence', async () => {
    const input = await publish()
    const receipt = await store.decide(input, allow)
    expect(receipt.providedKeys).toEqual(['EXAMPLE_API_KEY'])
    expect(receipt.skippedKeys).toEqual(['OTHER_TOKEN'])
    expect(receipt.summary).not.toContain('exact bytes')
    const view = await store.read(input.requestId)
    expect(JSON.stringify(view)).not.toContain('exact bytes')
    expect(view?.fields).toEqual([{ ...fields[0], existing: true }, { ...fields[1], existing: false }])
    const raw = await db.execute({ sql: 'SELECT sealed_value FROM desktop_secret_credentials WHERE agent_id = ? AND key = ?', args: [source.agentId, fields[0].key] })
    expect(String(raw.rows[0]!.sealed_value)).not.toContain('exact bytes')
    const used = await store.useCredential(source.agentId, fields[0].key, allow, value => new TextDecoder().decode(value))
    expect(used).toBe('  exact bytes\r\n')
})

test('same-attempt replay returns the sealed receipt and changed body refuses without replacing it', async () => {
    const input = await publish()
    const first = await store.decide(input, allow)
    await expect(store.decide(input, allow)).resolves.toEqual(first)
    await expect(store.decide({ ...input, values: { EXAMPLE_API_KEY: 'replacement' } }, allow)).rejects.toMatchObject({ status: 409 })
    await expect(store.useCredential(source.agentId, fields[0].key, allow, value => new TextDecoder().decode(value))).resolves.toBe('  exact bytes\r\n')
})

test('a staged attempt cannot replace a newer credential written by another request', async () => {
    const input = await publish()
    await store.stage(input, allow)
    const secondSource = { ...source, runId: 'newer-run', toolCallId: 'newer-tool', sourceMessageId: 'newer-message', fingerprint: 'newer-fingerprint' }
    const second = await store.publish({ source: secondSource, fields: [fields[0]] })
    await store.decide({ operation: 'save', requestId: second.requestId, attemptId: 'newer-attempt', expectedRevision: second.revision, source: secondSource, values: { EXAMPLE_API_KEY: 'newer-value' } }, allow)
    await expect(store.sealStaged(input, allow)).rejects.toMatchObject({ status: 409 })
    await expect(store.useCredential(source.agentId, fields[0].key, allow, value => new TextDecoder().decode(value))).resolves.toBe('newer-value')
})

test('concurrent Save and Skip cannot create two receipts or delete a stored credential', async () => {
    const input = await publish()
    const save = store.decide(input, allow)
    const skip = store.decide({ ...input, operation: 'skip', attemptId: 'skip-attempt', values: undefined }, allow)
    const results = await Promise.allSettled([save, skip])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const view = await store.read(input.requestId)
    expect(view?.receipt?.providedKeys).toEqual(['EXAMPLE_API_KEY'])
    expect(view?.receipt?.decision).toBe('save')
})

test('Skip and Dismiss preserve existing values and never fabricate provided names', async () => {
    const input = await publish()
    await store.decide(input, allow)
    const secondSource = { ...source, runId: 'second-run', toolCallId: 'second-tool', sourceMessageId: 'second-message', fingerprint: 'second-fingerprint' }
    const second = await store.publish({ source: secondSource, fields })
    const skipped = await store.decide({ operation: 'dismiss', requestId: second.requestId, attemptId: 'dismiss-attempt', expectedRevision: second.revision, source: secondSource }, allow)
    expect(skipped.providedKeys).toEqual([])
    expect(skipped.skippedKeys).toEqual(fields.map(field => field.key))
    await expect(store.useCredential(source.agentId, fields[0].key, allow, value => new TextDecoder().decode(value))).resolves.toBe('  exact bytes\r\n')
})

test('wrong source/owner and revoked authority refuse before credential effects', async () => {
    const input = await publish()
    await expect(store.decide({ ...input, source: { ...source, agentId: 'other' } }, allow)).rejects.toMatchObject({ status: 409 })
    await expect(store.decide(input, { check: () => { throw Object.assign(new Error('revoked'), { status: 403 }) } })).rejects.toMatchObject({ status: 403 })
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_secret_credentials')).rows[0]!.count).toBe(0)
})

test('lost acknowledgement recovers the same continuation after restart and port-independent reopen', async () => {
    const input = await publish()
    const sealed = await store.decide(input, allow)
    const reopened = createDesktopSecretRequestStore(db, crypto)
    await expect(reopened.decide(input, allow)).resolves.toEqual(sealed)
    await reopened.markAccepted(sealed.requestId, sealed.continuationRequestId, allow)
    await reopened.markAccepted(sealed.requestId, sealed.continuationRequestId, allow)
    expect((await reopened.read(input.requestId))?.status).toBe('accepted')
    await expect(reopened.markAccepted(sealed.requestId, 'different-run', allow)).rejects.toMatchObject({ status: 409 })
})

test('staged encrypted payload recovers without plaintext and definitive discard cleans only that attempt', async () => {
    const input = await publish()
    const staged = await store.stage(input, allow)
    expect(staged.receipt).toBeUndefined()
    const raw = await db.execute({ sql: 'SELECT sealed_payload FROM desktop_secret_attempts WHERE attempt_id = ?', args: [input.attemptId] })
    expect(String(raw.rows[0]!.sealed_payload)).not.toContain('exact bytes')
    const sealed = await store.sealStaged(input, allow)
    expect(sealed.providedKeys).toEqual(['EXAMPLE_API_KEY'])
    expect((await db.execute({ sql: 'SELECT sealed_payload FROM desktop_secret_attempts WHERE attempt_id = ?', args: [input.attemptId] })).rows[0]!.sealed_payload).toBeNull()
    const secondSource = { ...source, runId: 'discard-run', toolCallId: 'discard-tool', sourceMessageId: 'discard-message', fingerprint: 'discard-fingerprint' }
    const second = await store.publish({ source: secondSource, fields })
    const secondInput = { ...input, requestId: second.requestId, expectedRevision: second.revision, source: secondSource, attemptId: 'discard-me' }
    await store.stage(secondInput, allow)
    await store.discard(secondInput, allow)
    expect((await db.execute({ sql: 'SELECT sealed_payload FROM desktop_secret_attempts WHERE attempt_id = ?', args: [secondInput.attemptId] })).rows).toEqual([])
})

test('a definitive refusal clears staging and cannot later become a Save', async () => {
    const input = await publish()
    await store.stage(input, allow)
    await store.refuse(input, allow)
    expect((await db.execute({ sql: 'SELECT state,sealed_payload FROM desktop_secret_attempts WHERE attempt_id = ?', args: [input.attemptId] })).rows[0]).toMatchObject({ state: 'refused', sealed_payload: null })
    await expect(store.decide(input, allow)).rejects.toMatchObject({ status: 409 })
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_secret_credentials')).rows[0]!.count).toBe(0)
})

test('encryption context is bound to coworker/key/version and unauthorized consumers receive no bytes', async () => {
    const input = await publish()
    await store.decide(input, allow)
    const raw = await db.execute({ sql: 'SELECT sealed_value FROM desktop_secret_credentials WHERE agent_id = ? AND key = ?', args: [source.agentId, fields[0].key] })
    await expect(crypto.open({ domain: 'credential', agentId: 'other', key: fields[0].key, version: 1 }, String(raw.rows[0]!.sealed_value))).rejects.toThrow()
    const consumer = () => { throw new Error('must not run') }
    await expect(store.useCredential(source.agentId, fields[0].key, { check: () => { throw new Error('unauthorized') } }, consumer)).rejects.toThrow('unauthorized')
})

const recovery = (input: DesktopSecretRequestDecision): DesktopSecretRequestRecovery => ({
    operation: 'recover', requestId: input.requestId, attemptId: input.attemptId, expectedRevision: input.expectedRevision, source: input.source,
})

test('a fresh store recovers staged and sealed decisions using metadata only', async () => {
    const input = await publish()
    await store.stage(input, allow)
    const reopened = createDesktopSecretRequestStore(db, crypto)
    const recovered = await reopened.recover(recovery(input), allow)
    expect(recovered.replayOnly).toBe(false)
    expect(recovered.receipt.providedKeys).toEqual(['EXAMPLE_API_KEY'])
    const sealed = await createDesktopSecretRequestStore(db, crypto).recover(recovery(input), allow)
    expect(sealed).toEqual({ receipt: recovered.receipt, replayOnly: true })
    expect(JSON.stringify(sealed)).not.toContain('exact bytes')
    await expect(reopened.recover({ ...recovery(input), source: { ...source, runId: 'replacement' } }, allow)).rejects.toMatchObject({ status: 409 })
    await expect(reopened.recover({ ...recovery(input), expectedRevision: 'replacement' }, allow)).rejects.toMatchObject({ status: 409 })
    await expect(reopened.recover({ ...recovery(input), attemptId: 'replacement' }, allow)).rejects.toMatchObject({ status: 409 })
    expect((await db.execute('SELECT version FROM desktop_secret_credentials')).rows[0]?.version).toBe(1)
})

test('a different attempt cannot replace an encrypted staged decision', async () => {
    const input = await publish()
    await store.stage(input, allow)
    await expect(store.stage({ ...input, attemptId: 'new-attempt', values: { EXAMPLE_API_KEY: 'replacement' } }, allow)).rejects.toMatchObject({ status: 409 })
    expect((await store.read(input.requestId))?.pendingAttempt?.attemptId).toBe(input.attemptId)
})

test('credential consumption rechecks authority after decrypt and clears the temporary bytes', async () => {
    const input = await publish()
    await store.decide(input, allow)
    let revoked = false
    let plaintext: Uint8Array | undefined
    const reader = createDesktopSecretRequestStore(db, {
        ...crypto,
        open: async (context, sealed) => {
            plaintext = await crypto.open(context, sealed)
            revoked = true
            return plaintext
        },
    })
    const use = vi.fn()
    await expect(reader.useCredential(source.agentId, fields[0].key, { check: () => {
        if (revoked) throw Object.assign(new Error('revoked'), { status: 403 })
    } }, use)).rejects.toMatchObject({ status: 403 })
    expect(use).not.toHaveBeenCalled()
    expect(plaintext?.every(byte => byte === 0)).toBe(true)
})

test('accepted receipt and request state commit atomically and repair an old partial projection', async () => {
    const input = await publish()
    const sealed = await store.decide(input, allow)
    const transaction = db.transaction.bind(db)
    let failed = false
    const spy = vi.spyOn(db, 'transaction').mockImplementation(async () => {
        const tx = await transaction('write')
        return new Proxy(tx, {
            get(target, property) {
                if (property === 'execute') return async (...args: Parameters<typeof tx.execute>) => {
                    const sql = typeof args[0] === 'string' ? args[0] : args[0].sql
                    if (!failed && sql.startsWith('UPDATE desktop_secret_requests')) {
                        failed = true
                        throw new Error('Simulated loss between acceptance writes')
                    }
                    return target.execute(...args)
                }
                const value = Reflect.get(target, property)
                return typeof value === 'function' ? value.bind(target) : value
            },
        })
    })
    try {
        await expect(store.markAccepted(sealed.requestId, sealed.continuationRequestId, allow)).rejects.toThrow('between acceptance writes')
    } finally { spy.mockRestore() }
    expect((await store.read(input.requestId))?.receipt?.accepted).toBe(false)
    expect((await store.read(input.requestId))?.status).toBe('sealed')
    await db.execute({ sql: 'UPDATE desktop_secret_receipts SET accepted = 1 WHERE request_id = ?', args: [input.requestId] })
    await createDesktopSecretRequestStore(db, crypto).markAccepted(sealed.requestId, sealed.continuationRequestId, allow)
    expect((await store.read(input.requestId))?.status).toBe('accepted')
    expect((await store.read(input.requestId))?.receipt?.accepted).toBe(true)
    expect((await db.execute({ sql: 'SELECT status FROM desktop_secret_requests WHERE request_id = ?', args: [input.requestId] })).rows[0]?.status).toBe('accepted')
})
