import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openDesktopDatabase, closeDesktopDatabase } from '../database'
import { createDesktopAgent } from '../store'
import { createSelfMcpConfigAdapter } from './config'
import { desktopSelfMcpSchema } from './schema'
import type { SelfMcpApplyIdentity, SelfMcpEffectContext, SelfMcpServerCandidate } from './adapters'
import { selfMcpFingerprint } from './fingerprint'
let directory: string, db: Awaited<ReturnType<typeof openDesktopDatabase>>, owner: string
const server: SelfMcpServerCandidate = { name: 'arithmetic', transport: 'stdio', command: '/usr/local/bin/arithmetic-mcp', args: ['--json'], env: {}, headers: {} }
const applied = { outcome: 'applied_unverified' as const, detail: 'Saved without launching.' }
const context = (): SelfMcpEffectContext => ({ signal: new AbortController().signal, assertCurrent: async () => {} })
const config = () => createSelfMcpConfigAdapter({ db, managedNames: async () => [], mutate: async (_owner, _name, write) => write() })
const identity = (revision = 0): SelfMcpApplyIdentity => ({ launchEpoch: 'original-launch', decision: { id: 'human-decision', agentId: owner, proposalId: 'proposal', proposalRevision: 1, configRevision: revision, identity: { engineAgentId: 'engine-owner', sessionId: 'source-chat', runId: 'source-run', toolCallId: 'source-call' }, fingerprint: selfMcpFingerprint(server), outcome: { kind: 'approved' }, decidedAt: '2026-11-05T00:00:00Z' } })
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rerun-self-mcp-config-'))
    db = await openDesktopDatabase(directory); await db.executeMultiple(desktopSelfMcpSchema)
    owner = (await createDesktopAgent(db, { name: 'Config fixture', engineAgentId: 'engine-owner' })).id
})
afterEach(async () => { await closeDesktopDatabase(directory); await rm(directory, { recursive: true, force: true }) })

test('configuration and exact decision receipt commit together and recover after restart independently of current config equality', async () => {
    const adapter = config(), expected = identity()
    const receipt = await adapter.apply(owner, server, expected, context(), applied)
    expect(receipt.configRevision).toBeGreaterThan(expected.decision.configRevision)
    await db.execute({ sql: 'UPDATE desktop_mcp_stdio SET args=?,revision=? WHERE owner=? AND name=?', args: ['["--later-edit"]', 'later-config', owner, server.name] })
    await closeDesktopDatabase(directory); db = await openDesktopDatabase(directory)
    expect(await config().recover(owner, expected)).toEqual({ state: 'applied', receipt })
    expect(await config().revision(owner)).toBeGreaterThan(receipt.configRevision)
    expect(await config().recover(owner, { ...expected, decision: { ...expected.decision, id: 'never-applied' } })).toEqual({ state: 'not_applied' })
    await expect(config().recover(owner, { ...expected, decision: { ...expected.decision, configRevision: 99 } })).rejects.toThrow('another decision')
})

test('a failed final authority check rolls back configuration, revision and receipt together', async () => {
    const adapter = config(), guard = context()
    let checks = 0
    guard.assertCurrent = async () => { if (++checks === 3) throw new Error('Source stopped before commit') }
    await expect(adapter.apply(owner, server, identity(), guard, applied)).rejects.toThrow('Source stopped')
    expect((await db.execute('SELECT * FROM desktop_mcp_stdio')).rows).toEqual([])
    expect((await db.execute('SELECT * FROM desktop_self_mcp_effects')).rows).toEqual([])
    expect(await adapter.revision(owner)).toBe(0)
})

test('the canonical configuration CAS also detects manual connection edits', async () => {
    const adapter = config(), expected = identity()
    await db.execute({ sql: 'INSERT INTO desktop_mcp_stdio(owner,name,executable,args,revision) VALUES(?,?,?,?,?)', args: [owner, 'unrelated', '/usr/local/bin/other-mcp', '[]', 'manual'] })
    await expect(adapter.apply(owner, server, expected, context(), applied)).rejects.toThrow('configuration changed')
    expect((await db.execute('SELECT name FROM desktop_mcp_stdio')).rows).toEqual([{ name: 'unrelated' }])
    expect(await adapter.recover(owner, expected)).toEqual({ state: 'not_applied' })
})

test('preexisting equal configuration is never used as proof that this decision applied', async () => {
    await db.execute({ sql: 'INSERT INTO desktop_mcp_stdio(owner,name,executable,args,revision) VALUES(?,?,?,?,?)', args: [owner, server.name, server.command!, JSON.stringify(server.args), 'manual'] })
    const adapter = config()
    expect(await adapter.hasServer(owner, server)).toBe(true)
    expect(await adapter.recover(owner, identity(await adapter.revision(owner)))).toEqual({ state: 'not_applied' })
})

test('unsupported references and credential-bearing existing connections cannot be silently replaced', async () => {
    const adapter = config()
    const withReferences = { ...server, env: { API_TOKEN: '${API_TOKEN}' } }
    await expect(adapter.apply(owner, withReferences, identity(), context(), applied)).rejects.toThrow('requirements')
    await db.execute({ sql: "INSERT INTO desktop_remote_mcp(id,transport,agent_id,name,url,revision,bearer) VALUES('remote-id','http',?,?,?,'saved-revision','sealed-existing')", args: [owner, 'remote', 'https://example.com/mcp'] })
    const remote: SelfMcpServerCandidate = { name: 'remote', transport: 'http', url: 'https://another.example.com/mcp', args: [], env: {}, headers: {} }
    const remoteDecision = identity(await adapter.revision(owner)); remoteDecision.decision.fingerprint = selfMcpFingerprint(remote)
    await expect(adapter.apply(owner, remote, remoteDecision, context(), applied)).rejects.toThrow('already has credentials')
    expect((await db.execute('SELECT url,bearer FROM desktop_remote_mcp')).rows).toEqual([{ url: 'https://example.com/mcp', bearer: 'sealed-existing' }])
})


test('recovery does not infer a missing effect while this process still has an application in flight', async () => {
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const adapter = createSelfMcpConfigAdapter({ db, managedNames: async () => [], mutate: async (_owner, _name, write) => { entered(); await waiting; return write() } })
    const expected = identity(), pending = adapter.apply(owner, server, expected, context(), applied)
    await started
    expect(await config().recover(owner, expected)).toEqual({ state: 'uncertain' })
    release(); const receipt = await pending
    expect(await config().recover(owner, expected)).toEqual({ state: 'applied', receipt })
})


test('an effect cannot silently apply a candidate different from the human-reviewed fingerprint', async () => {
    const adapter = config()
    await expect(adapter.apply(owner, { ...server, args: ['--changed'] }, identity(), context(), applied)).rejects.toThrow('reviewed proposal')
    expect((await db.execute('SELECT * FROM desktop_mcp_stdio')).rows).toEqual([])
})
