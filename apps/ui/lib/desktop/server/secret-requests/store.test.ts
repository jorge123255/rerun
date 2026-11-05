import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createDesktopSecretCrypto } from './crypto'
import { ensureDesktopSecretRequestSchema } from './schema'
import { createDesktopSecretRequestStore, type DesktopSecretRequestStore } from './store'
import type { DesktopSecretRequestDecision, DesktopSecretRequestSource } from '../../../../../../packages/contracts/src/desktop-secret-requests'

let db: Client
let store: DesktopSecretRequestStore
const crypto = createDesktopSecretCrypto(() => Buffer.alloc(32, 7))
const source: DesktopSecretRequestSource = { agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint' }
const fields = [{ key: 'EXAMPLE_API_KEY', label: 'Example API key' }, { key: 'OTHER_TOKEN', label: 'Other token' }]
const allow = { check: () => {} }

beforeEach(async () => {
    db = createClient({ url: ':memory:' })
    await db.executeMultiple('CREATE TABLE desktop_agents (id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT);')
    await ensureDesktopSecretRequestSchema(db)
    store = createDesktopSecretRequestStore(db, crypto)
    await store.publish({ source, fields, reason: 'Use the API.' })
})
afterEach(() => db.close())

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
    const raw = await db.execute('SELECT sealed_value FROM desktop_secret_credentials WHERE agent_id = ? AND key = ?', { args: [source.agentId, fields[0].key] })
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
    await reopened.markAccepted(sealed.requestId, sealed.continuationRequestId)
    await reopened.markAccepted(sealed.requestId, sealed.continuationRequestId)
    expect((await reopened.read(input.requestId))?.status).toBe('accepted')
    await expect(reopened.markAccepted(sealed.requestId, 'different-run')).rejects.toMatchObject({ status: 409 })
})

test('staged encrypted payload recovers without plaintext and definitive discard cleans only that attempt', async () => {
    const input = await publish()
    const staged = await store.stage(input, allow)
    expect(staged.receipt).toBeUndefined()
    const raw = await db.execute('SELECT sealed_payload FROM desktop_secret_attempts WHERE attempt_id = ?', { args: [input.attemptId] })
    expect(String(raw.rows[0]!.sealed_payload)).not.toContain('exact bytes')
    const sealed = await store.sealStaged(input, allow)
    expect(sealed.providedKeys).toEqual(['EXAMPLE_API_KEY'])
    expect((await db.execute('SELECT sealed_payload FROM desktop_secret_attempts WHERE attempt_id = ?', { args: [input.attemptId] })).rows[0]!.sealed_payload).toBeNull()
    const secondSource = { ...source, runId: 'discard-run', toolCallId: 'discard-tool', sourceMessageId: 'discard-message', fingerprint: 'discard-fingerprint' }
    const second = await store.publish({ source: secondSource, fields })
    const secondInput = { ...input, requestId: second.requestId, expectedRevision: second.revision, source: secondSource, attemptId: 'discard-me' }
    await store.stage(secondInput, allow)
    await store.discard(secondInput)
    expect((await db.execute('SELECT sealed_payload FROM desktop_secret_attempts WHERE attempt_id = ?', { args: [secondInput.attemptId] })).rows).toEqual([])
})

test('a definitive refusal clears staging and cannot later become a Save', async () => {
    const input = await publish()
    await store.stage(input, allow)
    await store.refuse(input)
    expect((await db.execute('SELECT state,sealed_payload FROM desktop_secret_attempts WHERE attempt_id = ?', { args: [input.attemptId] })).rows[0]).toMatchObject({ state: 'refused', sealed_payload: null })
    await expect(store.decide(input, allow)).rejects.toMatchObject({ status: 409 })
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_secret_credentials')).rows[0]!.count).toBe(0)
})

test('encryption context is bound to coworker/key/version and unauthorized consumers receive no bytes', async () => {
    const input = await publish()
    await store.decide(input, allow)
    const raw = await db.execute('SELECT sealed_value FROM desktop_secret_credentials WHERE agent_id = ? AND key = ?', { args: [source.agentId, fields[0].key] })
    await expect(crypto.open({ domain: 'credential', agentId: 'other', key: fields[0].key, version: 1 }, String(raw.rows[0]!.sealed_value))).rejects.toThrow()
    const consumer = () => { throw new Error('must not run') }
    await expect(store.useCredential(source.agentId, fields[0].key, { check: () => { throw new Error('unauthorized') } }, consumer)).rejects.toThrow('unauthorized')
})
