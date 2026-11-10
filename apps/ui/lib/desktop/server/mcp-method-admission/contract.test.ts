import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopMcpSignInSource } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { createDesktopMcpSignInStore } from '../mcp-sign-in/store'
import { desktopMcpSignInSchema } from '../mcp-sign-in/schema'
import { createDeviceReviewStore, desktopMcpDeviceReviewSchema } from '../mcp-device-approval/store'
import { createTrustedMcpDeviceMethodReview } from '../mcp-device-approval/service'
import { sourceScope } from '../mcp-device-approval/model'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import { createMcpCredentialGeneration } from '../mcp/credential-generation'
import { remoteMcpStore, remoteMcpOAuthSchema, type OAuthTokenBundle } from '../mcp/store'
import { digest } from '../mcp-device-custody/model'
import { createMcpMethodAdmission, desktopMcpMethodAdmissionSchema, type ApprovedSignInMethod, type SignInMethodAdmissionPorts, type SignInMethodRequest } from './contract'

const databases: Client[] = [], roots: string[] = [], cleanup: (() => void)[] = []
afterEach(async () => {
    cleanup.splice(0).forEach(close => close()); databases.splice(0).forEach(db => db.close())
    await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
    vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-mcp-method-admission-')); roots.push(root)
    const url = `file:${join(root, 'fixture.db')}`
    const open = () => { const db = createClient({ url }); databases.push(db); return db }
    const db = open(), key = () => Buffer.alloc(32, 31), signal = new AbortController().signal, shutdown = new AbortController()
    await db.executeMultiple(`CREATE TABLE desktop_agents(id TEXT PRIMARY KEY,workspace_id TEXT,engine_agent_id TEXT);
        INSERT INTO desktop_agents VALUES('coworker','workspace','engine-coworker');
        CREATE TABLE desktop_sessions(id TEXT PRIMARY KEY,agent_id TEXT,engine_session_id TEXT);
        INSERT INTO desktop_sessions VALUES('local-chat','coworker','engine-chat');
        CREATE TABLE desktop_remote_mcp(id TEXT, transport TEXT, agent_id TEXT, name TEXT, url TEXT, revision TEXT, bearer TEXT, PRIMARY KEY(agent_id,name));
        INSERT INTO desktop_remote_mcp VALUES('registration','http','coworker','docs','https://docs.example/mcp','r1',NULL);
        ${remoteMcpOAuthSchema} ${desktopMcpSignInSchema} ${desktopMcpDeviceReviewSchema} ${desktopMcpMethodAdmissionSchema}
        CREATE TABLE fixture_browser_generation(attempt_id TEXT PRIMARY KEY,sealed TEXT);`)
    const source: DesktopMcpSignInSource = { agentId: 'coworker', sessionId: 'local-chat', runId: 'source-run', sourceMessageId: 'source-message', toolCallId: 'source-tool', fingerprint: 'exact-source-body',
        server: { name: 'docs', revision: 'r1', url: 'https://docs.example/mcp', displayName: 'Docs' } }
    const store = remoteMcpStore(db, key), browser = createDesktopMcpSignInStore(db), privateCrypto = createDesktopSecretCrypto(key)
    let time = 1_000_000, allowed = true
    const generations = createMcpCredentialGeneration({ store, key, now: () => time })
    const check = () => { if (!allowed) throw new Error('FIXTURE_PRIVATE_AUTHORITY_ERROR') }
    const generation = (await generations.read(source.agentId, source.server.name, signal))!
    cleanup.push(generation.dispose)
    const request = await browser.publish({ name: 'docs', source }, { check })
    const browserApprovalId = randomUUID()
    await browser.beginAttempt({ requestId: request.requestId, expectedRevision: request.revision, attemptId: browserApprovalId, operation: 'connect', source }, { check })
    const browserProof: ApprovedSignInMethod = { workspaceId: 'workspace', owner: source.agentId, engineAgentId: 'engine-coworker', engineSessionId: 'engine-chat',
        registrationId: 'registration', revision: 'r1', name: 'docs', resource: source.server.url, requestId: request.requestId, approvalId: browserApprovalId,
        method: 'browser', credentialGeneration: generation.generation, expiresAt: time + 120_000 }
    const proofContext = { domain: 'staging' as const, agentId: source.agentId, key: `fixture-browser-approval:${browserApprovalId}`, version: 1 }
    const bytes = Buffer.from(JSON.stringify(browserProof))
    const sealed = await privateCrypto.seal(proofContext, bytes); bytes.fill(0)
    await db.execute({ sql: 'INSERT INTO fixture_browser_generation VALUES(?,?)', args: [browserApprovalId, sealed] })
    const reviews = createTrustedMcpDeviceMethodReview({
        workspaceId: 'workspace', store: createDeviceReviewStore(db, key), shutdown: shutdown.signal, now: () => time,
        authority: async (input, stop) => {
            check(); if (digest(input) !== digest(source)) throw new Error('foreign source')
            return { workspaceId: 'workspace', owner: source.agentId, engineAgentId: 'engine-coworker', sessionId: 'engine-chat', name: 'docs', revision: 'r1', url: source.server.url, signal: stop, check }
        },
        method: async (_owner, stop) => {
            const current = (await generations.read(source.agentId, 'docs', stop))!; cleanup.push(current.dispose)
            return { value: { registrationId: current.registrationId, credentialGeneration: current.generation, validUntil: time + 120_000,
                method: { kind: 'device-code-link-v1', resource: source.server.url, issuer: 'https://issuer.example/', deviceEndpoint: 'https://issuer.example/device', tokenEndpoint: 'https://issuer.example/token', verificationUri: 'https://issuer.example/activate', clientId: 'synthetic-client', scope: 'read' } }, signal: current.signal, check: current.check }
        }, stopCustody: async () => {},
    })
    cleanup.push(reviews.dispose)
    const review = await reviews.review(source, signal), deviceApprovalId = randomUUID()
    await reviews.decide(source, { reviewId: review.reviewId, revision: review.revision, decisionId: deviceApprovalId, operation: 'approve-device-method' }, signal)
    const browserInput: SignInMethodRequest = { source, method: 'browser', approvalId: browserApprovalId }
    const deviceInput: SignInMethodRequest = { source, method: 'device', approvalId: deviceApprovalId }
    const approved: SignInMethodAdmissionPorts['approved'] = async (input, tx, stop) => {
        check(); stop.throwIfAborted()
        if (digest(input.source) !== digest(source)) return null
        const owner = (await tx.execute({ sql: 'SELECT a.workspace_id,a.engine_agent_id,s.engine_session_id FROM desktop_agents a JOIN desktop_sessions s ON s.agent_id=a.id WHERE a.id=? AND s.id=?', args: [source.agentId, source.sessionId] })).rows[0]
        if (!owner || owner.workspace_id !== 'workspace' || owner.engine_agent_id !== 'engine-coworker' || owner.engine_session_id !== 'engine-chat') return null
        const human = await createDesktopMcpSignInStore(db).readBySource(source, tx)
        if (!human) return null
        let value: ApprovedSignInMethod
        if (input.method === 'browser') {
            const attempt = (await tx.execute({ sql: 'SELECT state FROM desktop_mcp_sign_in_attempts WHERE request_id=? AND attempt_id=?', args: [human.requestId, input.approvalId] })).rows[0]
            if (human.receipt || human.activeAttemptId !== input.approvalId || attempt?.state !== 'pending') return null
            const row = (await tx.execute({ sql: 'SELECT sealed FROM fixture_browser_generation WHERE attempt_id=?', args: [input.approvalId] })).rows[0]
            if (!row) return null
            const opened = await privateCrypto.open(proofContext, String(row.sealed))
            try { value = JSON.parse(new TextDecoder().decode(opened)) } finally { opened.fill(0) }
        } else {
            const saved = await createDeviceReviewStore(db, key).bySource('workspace', source.agentId, sourceScope('workspace', source), tx)
            if (!saved || saved.value.state !== 'approved' || saved.value.decision?.id !== input.approvalId || saved.value.decision.operation !== 'approve-device-method') return null
            const a = saved.value.approval
            value = { workspaceId: a.workspaceId, owner: a.owner, engineAgentId: a.engineAgentId, engineSessionId: a.sessionId, registrationId: a.registrationId,
                revision: a.revision, name: a.name, resource: a.method.resource, requestId: human.requestId, approvalId: input.approvalId,
                method: 'device', credentialGeneration: a.credentialGeneration, expiresAt: a.approvedUntil }
        }
        return { value, signal: stop, check }
    }
    const make = (connection = db, callback = approved) => {
        const localStore = remoteMcpStore(connection, key)
        const ports: SignInMethodAdmissionPorts = { db: connection, store: localStore, key, workspaceId: 'workspace', shutdown: shutdown.signal, approved: callback, now: () => time }
        const admission = createMcpMethodAdmission(ports); cleanup.push(admission.dispose)
        return { admission, ports, store: localStore }
    }
    const left = make(), right = make(open())
    const token = (accessToken: string): OAuthTokenBundle => ({ accessToken, expiresAt: time + 600_000, resource: source.server.url, issuer: 'https://issuer.example/', tokenEndpoint: 'https://issuer.example/token', clientId: 'synthetic-client' })
    return { db, open, key, source, signal, shutdown, browserInput, deviceInput, left, right, make, browser, approved, generation, store, token,
        advance: (ms: number) => { time += ms }, deny: () => { allowed = false } }
}

it.each(['browser', 'device'] as const)('admits only the explicit %s choice and refuses the other method for the exact request/generation', async method => {
    const f = await fixture(), input = method === 'browser' ? f.browserInput : f.deviceInput, other = method === 'browser' ? f.deviceInput : f.browserInput
    const selected = await f.left.admission.select(input, f.signal)
    expect(selected).toMatchObject({ method, state: 'selected', created: true })
    expect(await f.right.admission.select(input, f.signal)).toEqual({ ...selected, created: false })
    await expect(f.right.admission.select(other, f.signal)).rejects.toThrow('MCP sign-in method admission unavailable')
    expect((await f.db.execute('SELECT selection_id FROM desktop_mcp_method_admission')).rows).toHaveLength(1)
})

it('linearizes a browser/device race over two real SQLite connections and permits one external-start reservation', async () => {
    const f = await fixture(), external = vi.fn()
    vi.stubGlobal('fetch', () => { throw new Error('No network') })
    const results = await Promise.allSettled([f.left.admission.select(f.browserInput, f.signal), f.right.admission.select(f.deviceInput, f.signal)])
    const winners = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof f.left.admission.select>>> => result.status === 'fulfilled')
    expect(winners).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const id = winners[0]!.value.selectionId
    const permits = await Promise.allSettled([f.left.admission.reserve('coworker', id, f.signal), f.right.admission.reserve('coworker', id, f.signal)])
    for (const permit of permits) if (permit.status === 'fulfilled' && permit.value.execute) { permit.value.lease!.check(); external(); permit.value.lease!.dispose() }
    expect(external).toHaveBeenCalledTimes(1)
    expect((await f.db.execute('SELECT state FROM desktop_mcp_method_admission')).rows[0]?.state).toBe('reserved')
})

it('restores a durable reserved choice as unknown and never replays either method after reconstruction', async () => {
    const f = await fixture(), selected = await f.left.admission.select(f.deviceInput, f.signal)
    const permit = await f.left.admission.reserve('coworker', selected.selectionId, f.signal)
    expect(permit.execute).toBe(true)
    f.left.admission.dispose(); f.right.admission.dispose()
    const restored = f.make(f.open()).admission
    const before = await f.db.execute('SELECT version,sealed FROM desktop_mcp_method_admission')
    expect(await restored.inspect('coworker', selected.selectionId, f.signal)).toMatchObject({ state: 'unknown' })
    expect((await f.db.execute('SELECT version,sealed FROM desktop_mcp_method_admission')).rows).toEqual(before.rows)
    expect(await restored.reserve('coworker', selected.selectionId, f.signal)).toMatchObject({ execute: false, receipt: { state: 'unknown' } })
    expect(await restored.select(f.deviceInput, f.signal)).toMatchObject({ created: false, state: 'unknown' })
    await expect(restored.select(f.browserInput, f.signal)).rejects.toThrow()
})

it('revalidates the PR25 private credential generation before selection and before effect reservation', async () => {
    const f = await fixture(), selected = await f.left.admission.select(f.deviceInput, f.signal)
    await f.right.store.writeOAuth('coworker', 'docs', 'r1', f.token('FIXTURE_BROWSER_TOKEN'), f.signal)
    await expect(f.left.admission.reserve('coworker', selected.selectionId, f.signal)).rejects.toThrow()
    await expect(f.right.admission.select(f.browserInput, f.signal)).rejects.toThrow()
    expect((await f.db.execute('SELECT state FROM desktop_mcp_method_admission')).rows[0]?.state).toBe('selected')
    expect((await f.store.readOAuth('coworker', 'docs'))?.accessToken).toBe('FIXTURE_BROWSER_TOKEN')
})

it('preserves the PR25 conditional-write protection after a permit when a different credential wins', async () => {
    const f = await fixture(), selected = await f.left.admission.select(f.deviceInput, f.signal)
    const permit = await f.left.admission.reserve('coworker', selected.selectionId, f.signal)
    expect(permit.execute).toBe(true)
    await f.right.store.writeOAuth('coworker', 'docs', 'r1', f.token('FIXTURE_NEW_CREDENTIAL'), f.signal)
    const generation = createMcpCredentialGeneration({ store: f.left.store, key: f.key })
    await expect(generation.advance('coworker', 'docs', f.generation.generation, f.token('FIXTURE_LATE_DEVICE'), f.signal)).rejects.toThrow()
    expect((await f.store.readOAuth('coworker', 'docs'))?.accessToken).toBe('FIXTURE_NEW_CREDENTIAL')
    expect(await f.left.admission.reserve('coworker', selected.selectionId, f.signal)).toMatchObject({ execute: false })
})

it('Stop retires an unreserved choice, but an already reserved effect remains unknown with an aborted lease', async () => {
    const f = await fixture(), first = await f.left.admission.select(f.browserInput, f.signal)
    expect(await f.left.admission.retire('coworker', first.selectionId, f.signal)).toMatchObject({ state: 'retired' })
    expect(await f.left.admission.reserve('coworker', first.selectionId, f.signal)).toMatchObject({ execute: false, receipt: { state: 'retired' } })
    await expect(f.right.admission.select(f.deviceInput, f.signal)).rejects.toThrow()
    const g = await fixture(), selected = await g.left.admission.select(g.deviceInput, g.signal), permit = await g.left.admission.reserve('coworker', selected.selectionId, g.signal)
    expect(permit.execute).toBe(true)
    await expect(g.left.admission.retire('foreign', selected.selectionId, g.signal)).rejects.toThrow()
    permit.lease!.check()
    expect(await g.left.admission.retire('coworker', selected.selectionId, g.signal)).toMatchObject({ state: 'unknown' })
    expect(permit.lease!.signal.aborted).toBe(true); expect(() => permit.lease!.check()).toThrow()
    expect(await g.right.admission.reserve('coworker', selected.selectionId, g.signal)).toMatchObject({ execute: false, receipt: { state: 'unknown' } })
})

it('expiry, permission revoke and workspace shutdown cannot admit a new external effect', async () => {
    const f = await fixture(), selected = await f.left.admission.select(f.deviceInput, f.signal)
    f.advance(120_000)
    expect(await f.left.admission.inspect('coworker', selected.selectionId, f.signal)).toMatchObject({ state: 'expired' })
    await expect(f.left.admission.reserve('coworker', selected.selectionId, f.signal)).rejects.toThrow()
    const g = await fixture(), choice = await g.left.admission.select(g.browserInput, g.signal), permit = await g.left.admission.reserve('coworker', choice.selectionId, g.signal)
    g.deny(); await g.left.admission.retireOwner('coworker', g.signal)
    expect(permit.lease!.signal.aborted).toBe(true)
    expect(await g.right.admission.inspect('coworker', choice.selectionId, g.signal)).toMatchObject({ state: 'unknown' })
    g.shutdown.abort()
    await expect(g.right.admission.select(g.deviceInput, g.signal)).rejects.toThrow()
})

it('refuses changed owner/session/registration, missing approval and model-supplied sensitive fields', async () => {
    const f = await fixture()
    for (const input of [{ ...f.deviceInput, credentialGeneration: f.generation.generation }, { ...f.deviceInput, approvalId: randomUUID() }, { ...f.browserInput, source: { ...f.source, sessionId: 'foreign-chat' } }]) {
        await expect(f.left.admission.select(input, f.signal)).rejects.toThrow('MCP sign-in method admission unavailable')
    }
    await f.db.execute("UPDATE desktop_sessions SET engine_session_id='foreign-engine-chat'")
    await expect(f.left.admission.select(f.deviceInput, f.signal)).rejects.toThrow()
    await f.db.execute("UPDATE desktop_sessions SET engine_session_id='engine-chat'")
    await f.store.save('coworker', { name: 'docs', url: f.source.server.url, revision: 'r1' })
    await expect(f.left.admission.select(f.deviceInput, f.signal)).rejects.toThrow()
    expect((await f.db.execute('SELECT selection_id FROM desktop_mcp_method_admission')).rows).toEqual([])
})

it('encrypts the selection/proof and emits no generation, token or provider text in receipts or errors', async () => {
    const f = await fixture(), logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
    const selected = await f.left.admission.select(f.deviceInput, f.signal)
    const raw = JSON.stringify((await f.db.execute('SELECT * FROM desktop_mcp_method_admission')).rows)
    expect(raw).not.toContain(f.generation.generation)
    expect(raw).not.toContain('issuer.example')
    expect(JSON.stringify(selected)).not.toMatch(/credentialGeneration|engineSession|issuer|resource|token/i)
    const bad = f.make(f.open(), async () => { throw new Error('FIXTURE_PRIVATE_PROVIDER_ERROR') }).admission
    await expect(bad.select(f.browserInput, f.signal)).rejects.toThrow('MCP sign-in method admission unavailable')
    expect(logs.every(log => log.mock.calls.length === 0)).toBe(true)
    await f.db.execute("UPDATE desktop_mcp_method_admission SET sealed='damaged'")
    await expect(f.right.admission.inspect('coworker', selected.selectionId, f.signal)).rejects.toThrow()
})

it('fails closed before the root-owned additive migration and preserves ordinary credential writes', async () => {
    const f = await fixture()
    await f.db.execute('DROP TABLE desktop_mcp_method_admission')
    await expect(f.left.admission.select(f.browserInput, f.signal)).rejects.toThrow()
    await f.store.writeOAuth('coworker', 'docs', 'r1', f.token('FIXTURE_REFRESH_PATH'), f.signal)
    expect((await f.store.readOAuth('coworker', 'docs'))?.accessToken).toBe('FIXTURE_REFRESH_PATH')
    await f.db.executeMultiple(desktopMcpMethodAdmissionSchema)
    await f.db.executeMultiple(desktopMcpMethodAdmissionSchema)
    expect((await f.store.list('coworker'))[0]).toMatchObject({ id: 'registration', revision: 'r1' })
})
