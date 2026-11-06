import 'server-only'
import type { Client, Transaction } from '@libsql/client'
import { createHash } from 'node:crypto'
import { desktopToolInstallGuestId, desktopToolInstallOperationId, desktopToolInstallActionSchema, desktopToolInstallInputSchema, desktopToolInstallRunIdentitySchema, desktopToolInstallSnapshotSchema, type DesktopToolInstallStore, type DesktopToolInstallRunIdentity, type DesktopToolInstallSnapshot } from '@rerun/contracts'
import { desktopToolInstallSchema } from './schema'

const tails = new WeakMap<Client, Promise<unknown>>()
const sourceKey = (id: DesktopToolInstallRunIdentity) => createHash('sha256').update(JSON.stringify([id.agentId, id.sessionId, id.runId, id.toolCallId, id.proposalRevision])).digest('hex')
const recoverable = new Set(['approved', 'installing', 'partial', 'uncertain', 'interrupted', 'cancelled'])
const transitions: Record<string, Set<string>> = {
 'pending-approval': new Set(['approved', 'declined']), approved: new Set(['installing', 'uncertain', 'failed', 'cancelled']),
 installing: new Set(['installed', 'partial', 'failed', 'uncertain', 'cancelled']),
 partial: new Set(['installed', 'partial', 'failed', 'uncertain', 'cancelled']), uncertain: new Set(['installed', 'partial', 'failed', 'uncertain', 'cancelled']),
 interrupted: new Set(['installed', 'partial', 'failed', 'uncertain', 'cancelled']), cancelled: new Set(['installed', 'partial', 'failed', 'uncertain', 'cancelled']),
}
export function desktopToolInstallStore(db: Client): DesktopToolInstallStore {
 let ready: Promise<void> | undefined
 async function transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const previous = tails.get(db) ?? Promise.resolve()
  const work = previous.catch(() => {}).then(async () => {
   ready ??= db.executeMultiple(desktopToolInstallSchema).catch(error => { ready = undefined; throw error }); await ready
   const tx = await db.transaction('write')
   try { const value = await fn(tx); await tx.commit(); return value } finally { tx.close() }
  })
  tails.set(db, work.catch(() => {})); return work
 }
 const parsed = (raw: unknown) => raw == null || raw === 'null' ? null : desktopToolInstallSnapshotSchema.parse(JSON.parse(String(raw)))
 async function rowOf(tx: Transaction, operationId: string) { return (await tx.execute({ sql: 'SELECT * FROM desktop_tool_installs WHERE operation_id=?', args: [operationId] })).rows[0] }
 function assertIdentity(row: Record<string, unknown> | undefined, identity: DesktopToolInstallRunIdentity) {
  if (!row || JSON.stringify(desktopToolInstallRunIdentitySchema.parse(JSON.parse(String(row.identity)))) !== JSON.stringify(desktopToolInstallRunIdentitySchema.parse(identity))) throw new Error('Installation identity conflict')
 }
 function assertSnapshot(row: Record<string, unknown>, identity: DesktopToolInstallRunIdentity, snapshot: DesktopToolInstallSnapshot) {
  assertIdentity(row, identity)
  if (sourceKey(identity) !== sourceKey({ ...snapshot, guest: identity.guest }) || JSON.stringify(snapshot.packages.map(item => item.package)) !== String(row.packages)) throw new Error('Installation source or package conflict')
 }
 return {
  read: id => transaction(async tx => parsed((await rowOf(tx, id))?.snapshot)),
  reservation: id => transaction(async tx => { const row = await rowOf(tx, id); return row ? { operationId: id, identity: desktopToolInstallRunIdentitySchema.parse(JSON.parse(String(row.identity))), packages: desktopToolInstallInputSchema.parse({ packages: JSON.parse(String(row.packages)) }).packages } : null }),
  list: sessionId => transaction(async tx => (await tx.execute('SELECT snapshot FROM desktop_tool_installs')).rows.flatMap(row => { const value = parsed(row.snapshot); return value?.sessionId === sessionId ? [value] : [] }).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))),
  begin: (rawIdentity, operationId, rawPackages) => transaction(async tx => {
   const identity = desktopToolInstallRunIdentitySchema.parse(rawIdentity), packages = desktopToolInstallInputSchema.parse({ packages: rawPackages }).packages
   if (await desktopToolInstallOperationId(identity, packages) !== operationId) throw new Error('Installation operation conflict')
   const source = sourceKey(identity)
   const row = (await tx.execute({ sql: 'SELECT * FROM desktop_tool_installs WHERE source_key=? OR operation_id=?', args: [source, operationId] })).rows[0]
   if (row) { assertIdentity(row, identity); if (row.operation_id !== operationId || row.packages !== JSON.stringify(packages)) throw new Error('Installation proposal conflict'); return parsed(row.snapshot) ?? 'execute' }
   const now = new Date().toISOString()
   await tx.execute({ sql: 'INSERT INTO desktop_tool_installs VALUES(?,?,?,?,?,?,?)', args: [operationId, source, JSON.stringify(identity), JSON.stringify(packages), 'null', now, now] })
   return 'execute'
  }),
  complete: (identity, raw) => transaction(async tx => {
   const snapshot = desktopToolInstallSnapshotSchema.parse(raw), row = await rowOf(tx, snapshot.operationId)
   if (!row) throw new Error('Installation reservation is missing')
   assertSnapshot(row, identity, snapshot)
   if (snapshot.guestId !== await desktopToolInstallGuestId(identity.guest)) throw new Error('Installation guest conflict')
   const current = parsed(row.snapshot)
   if (current && (current.createdAt !== snapshot.createdAt || current.guestId !== snapshot.guestId)) throw new Error('Installation source conflict')
   if (current && JSON.stringify(current) === JSON.stringify(snapshot)) return
   if (!current ? snapshot.revision !== '1' || snapshot.status !== 'pending-approval' : BigInt(snapshot.revision) !== BigInt(current.revision) + BigInt(1) || !transitions[current.status]?.has(snapshot.status)) throw new Error('Installation completion conflict')
   const updated = await tx.execute({ sql: 'UPDATE desktop_tool_installs SET snapshot=?,updated_at=? WHERE operation_id=? AND snapshot=?', args: [JSON.stringify(snapshot), snapshot.updatedAt, snapshot.operationId, String(row.snapshot)] })
   if (updated.rowsAffected !== 1) throw new Error('Installation completion conflict')
  }),
  replay: (identity, raw) => transaction(async tx => {
   const action = desktopToolInstallActionSchema.parse(raw), row = await rowOf(tx, action.operationId); assertIdentity(row, identity)
   const request = (await tx.execute({ sql: 'SELECT * FROM desktop_tool_install_requests WHERE request_id=?', args: [action.requestId] })).rows[0]
   if (!request) return null
   if (request.operation_id !== action.operationId || request.body !== JSON.stringify(action) || request.identity !== JSON.stringify(desktopToolInstallRunIdentitySchema.parse(identity))) throw new Error('Installation request conflict')
   return parsed(request.result) ?? (action.operation === 'decide' ? parsed(row!.snapshot) : null)
  }),
  claim: (identity, raw) => transaction(async tx => {
   const action = desktopToolInstallActionSchema.parse(raw), row = await rowOf(tx, action.operationId); assertIdentity(row, identity)
   const current = parsed(row!.snapshot); if (!current) throw new Error('Installation proposal is not ready')
   const body = JSON.stringify(action), id = JSON.stringify(desktopToolInstallRunIdentitySchema.parse(identity))
   const prior = (await tx.execute({ sql: 'SELECT * FROM desktop_tool_install_requests WHERE request_id=?', args: [action.requestId] })).rows[0]
   if (prior) {
    if (prior.operation_id !== action.operationId || prior.identity !== id || prior.body !== body) throw new Error('Installation request conflict')
    return { claimed: action.operation === 'inspect' && prior.result == null, snapshot: parsed(prior.result) ?? current }
   }
   if (current.revision !== action.expectedRevision) throw new Error('This installation changed. Refresh it and try again.')
   if (action.operation === 'decide' && current.status !== 'pending-approval') throw new Error('This proposal already has a decision')
   if (action.operation === 'inspect' && !recoverable.has(current.status)) throw new Error('This installation does not need inspection')
   const snapshot: DesktopToolInstallSnapshot = action.operation === 'decide' ? { ...current, revision: String(BigInt(current.revision) + BigInt(1)), status: action.decision === 'approved' ? 'approved' : 'declined', updatedAt: new Date().toISOString(), ...(action.note ? { message: action.note.replace(/[\u0000-\u001f\u007f]/g, '').slice(0,1000) } : {}) } : current
   await tx.execute({ sql: 'UPDATE desktop_tool_installs SET snapshot=?,updated_at=? WHERE operation_id=? AND snapshot=?', args: [JSON.stringify(snapshot), snapshot.updatedAt, action.operationId, String(row!.snapshot)] })
   await tx.execute({ sql: 'INSERT INTO desktop_tool_install_requests VALUES(?,?,?,?,?)', args: [action.requestId, action.operationId, id, body, action.operation === 'decide' && action.decision === 'declined' ? JSON.stringify(snapshot) : null] })
   return { claimed: true, snapshot }
  }),
  finishRequest: (identity, rawAction, snapshot) => transaction(async tx => {
   const action = desktopToolInstallActionSchema.parse(rawAction), row = await rowOf(tx, action.operationId); assertIdentity(row, identity)
   assertSnapshot(row!, identity, desktopToolInstallSnapshotSchema.parse(snapshot))
   const current = parsed(row!.snapshot); if (!current || JSON.stringify(current) !== JSON.stringify(snapshot)) throw new Error('Installation receipt is not current')
   const request = (await tx.execute({ sql: 'SELECT * FROM desktop_tool_install_requests WHERE request_id=?', args: [action.requestId] })).rows[0]
   if (!request || request.body !== JSON.stringify(action) || request.identity !== JSON.stringify(desktopToolInstallRunIdentitySchema.parse(identity))) throw new Error('Installation request conflict')
   if (request.result != null) { if (request.result !== JSON.stringify(snapshot)) throw new Error('Installation receipt conflict'); return }
   await tx.execute({ sql: 'UPDATE desktop_tool_install_requests SET result=? WHERE request_id=? AND result IS NULL', args: [JSON.stringify(snapshot), action.requestId] })
  }),
 }
}
