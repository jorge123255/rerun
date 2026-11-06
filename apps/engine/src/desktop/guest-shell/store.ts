import type { Client, Transaction } from '@libsql/client'
import { desktopGuestShellIdentitySchema, desktopGuestShellReceiptSchema, desktopGuestShellRequestSchema, type DesktopGuestShellIdentity } from '@rerun/contracts'
import type { DesktopGuestShellStore } from './types.js'
import { isFinalGuestShellReceipt } from './service.js'

const tails = new WeakMap<Client, Promise<unknown>>()
const identityKey = (identity: DesktopGuestShellIdentity) => JSON.stringify(desktopGuestShellIdentitySchema.parse({ agentId: identity.agentId, sessionId: identity.sessionId, runId: identity.runId, toolCallId: identity.toolCallId, requestId: identity.requestId, guest: identity.guest }))
/** Host-owned receipts are authoritative across guest and app restarts. Commands are never persisted. */
export function desktopGuestShellStore(db: Client): DesktopGuestShellStore {
    async function write<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
        const previous = tails.get(db) ?? Promise.resolve()
        const task = previous.catch(() => {}).then(async () => {
            const tx = await db.transaction('write')
            try { const value = await work(tx); await tx.commit(); return value }
            catch (error) { await tx.rollback().catch(() => {}); throw error }
            finally { tx.close() }
        })
        tails.set(db, task.catch(() => {})); return task
    }
    const parse = (value: unknown) => desktopGuestShellReceiptSchema.parse(JSON.parse(String(value)))
    async function row(tx: Pick<Client, 'execute'> | Transaction, requestId: string) {
        return (await tx.execute({ sql: 'SELECT * FROM desktop_guest_shell_requests WHERE request_id=?', args: [requestId] })).rows[0]
    }
    function assertReceipt(identity: DesktopGuestShellIdentity, receipt: ReturnType<typeof parse>) {
        if (identityKey(identity) !== identityKey(receipt.identity) || receipt.requestId !== identity.requestId) throw new Error('Guest command receipt owner changed')
    }
    return {
        async read(requestId) { const saved = await row(db, requestId); if (!saved) return null; const receipt = parse(saved.receipt); if (receipt.requestId !== requestId || identityKey(receipt.identity) !== saved.identity || receipt.fingerprint !== saved.fingerprint) throw new Error('Guest command receipt changed'); return receipt },
        begin: (raw, initial) => write(async tx => {
            const request = desktopGuestShellRequestSchema.parse(raw), receipt = desktopGuestShellReceiptSchema.parse(initial)
            assertReceipt(request, receipt)
            if (request.fingerprint !== receipt.fingerprint || receipt.status !== 'interrupted') throw new Error('Guest command reservation changed')
            const saved = await row(tx, request.requestId)
            if (saved) {
                if (saved.identity !== identityKey(request) || saved.fingerprint !== request.fingerprint) throw new Error('Guest command request conflict')
                const previous = parse(saved.receipt); assertReceipt(request, previous); return previous
            }
            const count = (await tx.execute('SELECT COUNT(*) AS n FROM desktop_guest_shell_requests')).rows[0]
            if (Number(count.n) >= 16384) throw new Error('Guest command receipt capacity reached')
            const now = new Date().toISOString()
            await tx.execute({ sql: 'INSERT INTO desktop_guest_shell_requests(request_id,fingerprint,identity,receipt,created_at,updated_at) VALUES(?,?,?,?,?,?)', args: [request.requestId, request.fingerprint, identityKey(request), JSON.stringify(receipt), now, now] })
            return 'execute' as const
        }),
        complete: (identity, raw) => write(async tx => {
            const receipt = desktopGuestShellReceiptSchema.parse(raw); assertReceipt(identity, receipt)
            const saved = await row(tx, identity.requestId)
            if (!saved || saved.identity !== identityKey(identity) || saved.fingerprint !== receipt.fingerprint) throw new Error('Guest command reservation missing or changed')
            const previous = parse(saved.receipt)
            if (isFinalGuestShellReceipt(previous)) {
                // A delayed cancel/inspect must never overwrite a confirmed command outcome.
                if (JSON.stringify(previous) !== JSON.stringify(receipt)) throw new Error('Guest command already has a final result')
                return
            }
            const changed = await tx.execute({ sql: 'UPDATE desktop_guest_shell_requests SET receipt=?,updated_at=? WHERE request_id=? AND receipt=?', args: [JSON.stringify(receipt), new Date().toISOString(), identity.requestId, String(saved.receipt)] })
            if (changed.rowsAffected !== 1) throw new Error('Guest command receipt changed')
        }),
    }
}
