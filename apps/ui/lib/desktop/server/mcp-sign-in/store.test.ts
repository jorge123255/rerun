import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ensureDesktopMcpSignInSchema } from './schema'
import { createDesktopMcpSignInStore, type DesktopMcpSignInStore } from './store'
import type { DesktopMcpSignInDecision, DesktopMcpSignInSource } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'

let db: Client
let store: DesktopMcpSignInStore
const source: DesktopMcpSignInSource = {
    agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint',
    server: { name: 'linear', revision: 'revision-1', url: 'https://linear.example/mcp', displayName: 'Linear', host: 'linear.example', icon: null },
}
const allow = { check: () => {} }

beforeEach(async () => {
    db = createClient({ url: temporaryDatabaseUrl() })
    await db.executeMultiple(`CREATE TABLE desktop_agents (id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT); INSERT INTO desktop_agents VALUES ('agent'); INSERT INTO desktop_sessions VALUES ('chat','agent');`)
    await ensureDesktopMcpSignInSchema(db)
    store = createDesktopMcpSignInStore(db)
})
afterEach(() => db.close())

async function decision(operation: DesktopMcpSignInDecision['operation'] = 'connect'): Promise<DesktopMcpSignInDecision> {
    const view = await store.publish({ source, name: 'linear', reason: 'Use Linear.' })
    const input = { operation, requestId: view.requestId, attemptId: 'attempt', expectedRevision: view.revision, source }
    return operation === 'connect' ? { ...input, expectedRevision: (await store.begin(input, allow)).revision } : input
}

test('Connect is unresolved until fresh readiness seals it, then duplicate completion converges', async () => {
    const input = await decision()
    await store.begin(input, allow)
    expect((await store.read(input.requestId))?.status).toBe('connecting')
    const sealed = await store.seal(input, 'connected', allow)
    expect(sealed.outcome).toBe('connected')
    await expect(store.seal(input, 'connected', allow)).resolves.toEqual(sealed)
    await store.markAccepted(sealed.requestId, sealed.continuationRequestId)
    expect((await store.read(input.requestId))?.status).toBe('connected')
    expect(JSON.stringify(await store.read(input.requestId))).not.toContain('accessToken')
})

test('partial sealing failure remains honest and cannot create a receipt', async () => {
    const input = await decision()
    await store.begin(input, allow)
    await expect(store.seal(input, 'connected', { check: () => { throw new Error('not ready') } })).rejects.toThrow('not ready')
    expect((await store.read(input.requestId))?.receipt).toBeUndefined()
    await store.fail(input, 'Authorization failed. Retry.')
    expect((await store.read(input.requestId))?.status).toBe('error')
})

test('concurrent Connect and Not now cannot produce two continuations', async () => {
    const input = await decision()
    const connect = store.seal(input, 'connected', allow)
    const decline = store.seal({ ...input, operation: 'decline', attemptId: 'decline-attempt' }, 'declined', allow)
    const results = await Promise.allSettled([connect, decline])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await store.read(input.requestId))?.receipt).toBeDefined()
})

test('denied login and Cancel leave the request unresolved without fabricating success', async () => {
    const input = await decision()
    await store.begin(input, allow)
    const cancelled = await store.cancel({ ...input, operation: 'cancel' })
    expect((await store.read(input.requestId))?.status).toBe('pending')
    expect((await store.read(input.requestId))?.receipt).toBeUndefined()
    const declined = await store.seal({ ...input, operation: 'decline', attemptId: 'declined-attempt', expectedRevision: cancelled.revision }, 'declined', allow)
    expect(declined.outcome).toBe('declined')
})

test('changed registration and cross-owner decisions are refused before effects', async () => {
    const input = await decision()
    await expect(store.begin({ ...input, source: { ...source, server: { ...source.server, revision: 'replacement' } } }, allow)).rejects.toMatchObject({ status: 409 })
    await expect(store.begin({ ...input, source: { ...source, agentId: 'other' } }, allow)).rejects.toMatchObject({ status: 409 })
})

test('restart preserves sealed receipts and independent sibling requests', async () => {
    const input = await decision()
    const sealed = await store.seal(input, 'connected', allow)
    const otherSource = { ...source, toolCallId: 'other-tool', sourceMessageId: 'other-message', fingerprint: 'other-fingerprint', server: { ...source.server, name: 'notion', displayName: 'Notion' } }
    const sibling = await store.publish({ source: otherSource, name: 'notion' })
    expect(sibling.status).toBe('pending')
    const reopened = createDesktopMcpSignInStore(db)
    await expect(reopened.receipt(input)).resolves.toEqual(sealed)
    expect((await reopened.read(sibling.requestId))?.status).toBe('pending')
})

const temporaryDirectories: string[] = []
function temporaryDatabaseUrl() { const path = mkdtempSync(join(tmpdir(), 'rerun-ledger-')); temporaryDirectories.push(path); return `file:${join(path, 'app.db')}` }
afterEach(() => temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
