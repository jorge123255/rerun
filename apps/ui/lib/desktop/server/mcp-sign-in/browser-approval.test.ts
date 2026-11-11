import { createClient } from '@libsql/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopMcpSignInDecision } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { migrateDesktopSse } from '../mcp-sse/schema'
import { remoteMcpOAuthSchema, remoteMcpSchema, remoteMcpStore } from '../mcp/store'
import { initializeDesktopRound39 } from '../round39-schema'
import { createDesktopMcpBrowserApprovals } from './browser-approval'
import { createDesktopMcpSignInRuntimePorts } from './runtime'
import { ensureDesktopMcpSignInSchema } from './schema'
import { createDesktopMcpSignInStore } from './store'

vi.mock('server-only', () => ({}))
const key = () => Buffer.alloc(32, 42)
const signal = new AbortController().signal
const authority = { check() {} }
const scope = { owner: 'a', sessionId: 's', workspaceId: '1', engineAgentId: 'engine-a', engineSessionId: 'engine-s' }
const resource = 'https://browser-sign-in.example/mcp'
const token = () => ({
    resource, accessToken: 'synthetic-access-token', expiresAt: Date.now() + 3_600_000,
    issuer: 'https://browser-sign-in.example', tokenEndpoint: 'https://browser-sign-in.example/token', clientId: 'fixture',
})
const roots: string[] = []
const clients: ReturnType<typeof createClient>[] = []
afterEach(() => {
    clients.splice(0).forEach(client => client.close())
    roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})

async function fixture(now = Date.now) {
    const root = mkdtempSync(join(tmpdir(), 'rerun-browser-approval-')); roots.push(root)
    const open = () => { const db = createClient({ url: `file:${join(root, 'app.db')}` }); clients.push(db); return db }
    const db = open()
    await db.executeMultiple(`PRAGMA foreign_keys=ON;
        CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY,id TEXT NOT NULL);
        CREATE TABLE desktop_agents(id TEXT PRIMARY KEY);
        CREATE TABLE desktop_sessions(id TEXT PRIMARY KEY);
        INSERT INTO desktop_agents VALUES('a'); INSERT INTO desktop_sessions VALUES('s');
        ${remoteMcpSchema} ${remoteMcpOAuthSchema}`)
    await migrateDesktopSse(db)
    await ensureDesktopMcpSignInSchema(db)
    const remote = remoteMcpStore(db, key)
    const [registration] = await remote.save('a', { name: 'linear', url: resource })
    const source = { agentId: 'a', sessionId: 's', runId: 'r', sourceMessageId: 'm', toolCallId: 't', fingerprint: 'f', server: { name: registration.name, revision: registration.revision, url: resource, displayName: 'Linear' } }
    const signIn = createDesktopMcpSignInStore(db)
    const view = await signIn.publish({ name: 'linear', source })
    const input: DesktopMcpSignInDecision = { operation: 'connect', attemptId: 'approval-a', requestId: view.requestId, expectedRevision: view.revision, source }
    const browser = createDesktopMcpBrowserApprovals(db, remote, key, scope, now)
    return { db, open, remote, signIn, browser, input, registration }
}

test('Connect records the encrypted approval before the first browser effect and never replays it on reopen', async () => {
    const { db, open, remote, signIn, browser, input, registration } = await fixture()
    await initializeDesktopRound39(db)
    await initializeDesktopRound39(db)
    const start = vi.fn(async () => {
        const credential = await remote.browserCredentialState('a', 'linear')
        expect(await browser.assertCurrent(input, credential!)).toMatchObject({ attemptId: input.attemptId, requestId: input.requestId })
        return { state: 'waiting' as const }
    })
    const ports = {
        store: signIn, captureBrowserApproval: browser.capture, source: async () => null, authority: async () => authority,
        oauth: { start, status: async () => ({ state: 'idle' as const }), cancel: async () => {}, ready: async () => {} },
        send: async () => { throw Error('Unexpected continuation') },
    }
    const response = await createDesktopMcpSignInRuntimePorts(ports).connect(input, signal)
    const next = open(), nextRemote = remoteMcpStore(next, key), nextBrowser = createDesktopMcpBrowserApprovals(next, nextRemote, key, scope)
    const saved = (await nextBrowser.read(input))!
    expect(saved.approval).toMatchObject({ method: 'browser', workspaceId: '1', registrationId: registration.id, engineSessionId: scope.engineSessionId })
    expect(saved.sealed).not.toContain(saved.approval.credentialGeneration)
    expect(JSON.stringify(response)).not.toContain(saved.approval.credentialGeneration)
    expect(await nextBrowser.read({ ...input, source: { ...input.source, runId: 'other-run' } })).toBeNull()
    await createDesktopMcpSignInRuntimePorts({ ...ports, store: createDesktopMcpSignInStore(next), captureBrowserApproval: nextBrowser.capture }).connect(input, signal)
    expect(start).toHaveBeenCalledTimes(1)
    expect((await nextBrowser.read(input))?.sealed).toBe(saved.sealed)
})

test('migration does not convert a legacy pending attempt into an approval', async () => {
    const { db, signIn, input, browser } = await fixture()
    await signIn.begin(input, authority)
    await initializeDesktopRound39(db)
    expect(await browser.read(input)).toBeNull()
    expect((await signIn.read(input.requestId))?.activeAttemptId).toBe(input.attemptId)
})

test('a changed registration rolls back the attempt and any approval together', async () => {
    const { db, signIn, input, browser, remote, registration } = await fixture()
    await initializeDesktopRound39(db)
    await remote.save('a', { name: 'linear', url: resource, revision: registration.revision })
    await expect(signIn.beginAttempt(input, authority, browser.capture)).rejects.toThrow('approval changed')
    expect((await signIn.read(input.requestId))?.activeAttemptId).toBeUndefined()
    expect((await db.execute('SELECT attempt_id FROM desktop_mcp_sign_in_attempts')).rows).toEqual([])
})

test('a newer credential and an expired approval both fail the browser preflight', async () => {
    let now = Date.now()
    const { db, signIn, input, browser, remote, registration } = await fixture(() => now)
    await initializeDesktopRound39(db)
    await signIn.beginAttempt(input, authority, browser.capture)
    const original = (await remote.browserCredentialState('a', 'linear'))!
    await remote.writeOAuth('a', 'linear', registration.revision, token(), signal)
    const newer = (await remote.browserCredentialState('a', 'linear'))!
    await expect(browser.assertCurrent(input, newer)).rejects.toThrow('approval changed')
    now += 5 * 60_000
    await expect(browser.assertCurrent(input, original)).rejects.toThrow('approval changed')
})

test('a cancelled approval cannot commit a late credential from a separate store', async () => {
    const { db, open, signIn, input, browser, remote } = await fixture()
    await initializeDesktopRound39(db)
    const begun = await signIn.beginAttempt(input, authority, browser.capture)
    const original = (await remote.browserCredentialState('a', 'linear'))!
    const admission = await browser.assertCurrent(input, original)
    await createDesktopMcpSignInStore(open()).cancel({ ...input, operation: 'cancel', expectedRevision: begun.request.revision }, authority)
    await expect(remote.replaceOAuth('a', 'linear', original, token(), signal, admission)).rejects.toThrow('credential generation changed')
    expect(await remote.readOAuth('a', 'linear')).toBeNull()
    expect(await browser.read(input)).toBeNull()
})

test('the credential write accepts the exact active unexpired approval', async () => {
    const { db, signIn, input, browser, remote } = await fixture()
    await initializeDesktopRound39(db)
    await signIn.beginAttempt(input, authority, browser.capture)
    const original = (await remote.browserCredentialState('a', 'linear'))!
    const admission = await browser.assertCurrent(input, original)
    const bundle = token()
    await remote.replaceOAuth('a', 'linear', original, bundle, signal, admission)
    expect(await remote.readOAuth('a', 'linear')).toEqual(bundle)
})
