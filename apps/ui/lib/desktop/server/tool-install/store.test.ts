import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopToolInstallService, type DesktopToolInstallPorts, type DesktopToolInstallSnapshot } from '@rerun/contracts'
import { desktopToolInstallStore } from './store'
const databases: ReturnType<typeof createClient>[] = []
afterEach(() => databases.splice(0).forEach(db => db.close()))
const base = { agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'call', proposalRevision: '1' }
const guest = { engineAgentId: 'engine', launchNonce: 'launch', sessionGeneration: 'a'.repeat(32), workspaceFingerprint: 'b'.repeat(64) }
const targets = ['left-pad@1.2.3']
const installed = { status: 'installed' as const, packages: [{ package: targets[0]!, status: 'installed' as const, manifestSha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64) }] }
function fixture() {
 const db = createClient({ url: temporaryDatabaseUrl() }); databases.push(db)
 const store = desktopToolInstallStore(db), execute = vi.fn(async () => installed), inspect = vi.fn(async () => installed)
 const ports: DesktopToolInstallPorts = { outcomes: store, authority: vi.fn(async () => guest), guest: { execute, inspect } }
 return { db, store, ports, execute, inspect, service: createDesktopToolInstallService(ports) }
}
const decide = (row: DesktopToolInstallSnapshot, decision: 'approved' | 'declined' = 'approved') => ({ operation: 'decide' as const, requestId: crypto.randomUUID(), operationId: row.operationId, expectedRevision: row.revision, decision })
const inspectAction = (row: DesktopToolInstallSnapshot) => ({ operation: 'inspect' as const, requestId: crypto.randomUUID(), operationId: row.operationId, expectedRevision: row.revision })
it('atomically admits only one of two independent service instances and replays the exact request', async () => {
 const box = fixture(), row = await box.service.propose(base, { packages: targets }), action = decide(row)
 let started!: () => void, finish!: (result: typeof installed) => void
 const began = new Promise<void>(resolve => { started = resolve })
 box.ports.guest.execute = vi.fn(() => { started(); return new Promise<typeof installed>(resolve => { finish = resolve }) })
 const other = createDesktopToolInstallService({ ...box.ports, outcomes: desktopToolInstallStore(box.db) })
 const first = box.service.decide(base, action); await began
 await expect(other.decide(base, decide(row))).rejects.toThrow('changed')
 await expect(other.decide(base, action)).resolves.toMatchObject({ status: 'installing' })
 finish(installed); await expect(first).resolves.toMatchObject({ status: 'installed' })
 const reconstructed = createDesktopToolInstallService({ ...box.ports, outcomes: desktopToolInstallStore(box.db), authority: vi.fn(async () => { throw new Error('guest gone') }) })
 await expect(reconstructed.decide(base, action)).resolves.toMatchObject({ status: 'installed' })
 expect(box.ports.guest.execute).toHaveBeenCalledTimes(1)
})
it('binds changed targets, guest, owner and request body to the original immutable proposal', async () => {
 const box = fixture(), row = await box.service.propose(base, { packages: targets })
 await expect(box.service.propose(base, { packages: ['left-pad@1.2.4'] })).rejects.toThrow('proposal conflict')
 box.ports.authority = async () => ({ ...guest, sessionGeneration: 'c'.repeat(32) })
 await expect(box.service.propose(base, { packages: targets })).rejects.toThrow('identity conflict')
 await expect(box.service.decide({ ...base, agentId: 'sibling' }, decide(row))).rejects.toThrow('another proposal')
 box.ports.authority = async () => guest
 const action = decide(row, 'declined'); await box.service.decide(base, action)
 await expect(box.service.decide(base, { ...action, decision: 'approved' })).rejects.toThrow('request conflict')
 expect(box.execute).not.toHaveBeenCalled()
})
it('recovers a persisted approved phase by inspection without executing on restart', async () => {
 const box = fixture(), row = await box.service.propose(base, { packages: targets }), action = decide(row)
 const reservation = (await box.store.reservation(row.operationId))!
 const approved = await box.store.claim(reservation.identity, action)
 const restored = createDesktopToolInstallService({ ...box.ports, outcomes: desktopToolInstallStore(box.db) })
 expect((await restored.read(row.operationId))?.status).toBe('approved')
 await expect(restored.decide(base, action)).resolves.toMatchObject({ status: 'approved' })
 box.ports.guest.inspect = vi.fn(async () => ({ status: 'failed' as const, packages: [{ package: targets[0]!, status: 'failed' as const }], message: 'Not submitted' }))
 await expect(box.service.inspect(base, inspectAction(approved.snapshot))).resolves.toMatchObject({ status: 'failed' })
 expect(box.execute).not.toHaveBeenCalled()
})
it('allows exact acknowledged writes but never overwrites a terminal decision with a higher revision', async () => {
 const box = fixture(), row = await box.service.propose(base, { packages: targets }), operation = (await box.store.reservation(row.operationId))!
 await expect(box.store.complete(operation.identity, row)).resolves.toBeUndefined()
 const declined = await box.service.decide(base, decide(row, 'declined'))
 await expect(box.store.complete(operation.identity, { ...declined, revision: String(BigInt(declined.revision) + BigInt(1)), status: 'installing' })).rejects.toThrow('completion conflict')
 await expect(box.store.complete(operation.identity, { ...declined, packages: [{ package: 'other@1.0.0', status: 'pending' }], revision: '3' })).rejects.toThrow('package conflict')
})
it('retains submitted state after a lost final write and explicitly inspects without reinstalling', async () => {
 const box = fixture(), row = await box.service.propose(base, { packages: targets }), complete = box.store.complete
 let fail = true
 box.store.complete = async (identity, snapshot) => { if (snapshot.status === 'installed' && fail) { fail = false; throw new Error('lost write') } await complete(identity, snapshot) }
 const result = await box.service.decide(base, decide(row))
 expect(result.status).toBe('installing')
 await expect(box.service.inspect(base, inspectAction(result))).resolves.toMatchObject({ status: 'installed' })
 expect(box.execute).toHaveBeenCalledTimes(1); expect(box.inspect).toHaveBeenCalledTimes(1)
})
it('refuses malformed/extra guest evidence and preserves a readable uncertain receipt', async () => {
 const box = fixture(), row = await box.service.propose(base, { packages: targets })
 box.ports.guest.execute = vi.fn(async () => ({ ...installed, packages: [...installed.packages, { ...installed.packages[0]!, package: 'other@1.0.0' }] }))
 await expect(box.service.decide(base, decide(row))).resolves.toMatchObject({ status: 'uncertain' })
 expect((await box.store.read(row.operationId))?.status).toBe('uncertain')
})
it('waits for guest cancellation/drain before saving an uncertain result', async () => {
 const box = fixture(), row = await box.service.propose(base, { packages: targets }), controller = new AbortController()
 let started!: () => void, drain!: () => void
 const began = new Promise<void>(resolve => { started = resolve }), drained = new Promise<void>(resolve => { drain = resolve })
 box.ports.guest.execute = vi.fn(async (_op, signal) => { started(); await drained; signal.throwIfAborted(); return installed })
 let settled = false
 const result = box.service.decide(base, decide(row), controller.signal).finally(() => { settled = true })
 await began; controller.abort(); await Promise.resolve(); expect(settled).toBe(false)
 drain(); await expect(result).resolves.toMatchObject({ status: 'uncertain' })
})

const temporaryDirectories: string[] = []
function temporaryDatabaseUrl() { const path = mkdtempSync(join(tmpdir(), 'rerun-ledger-')); temporaryDirectories.push(path); return `file:${join(path, 'app.db')}` }
afterEach(() => temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
