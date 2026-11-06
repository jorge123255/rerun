import 'server-only'
import type { Client } from '@libsql/client'
import { serviceTransportControlSchema, serviceTransportReceiptSchema, type ServiceTransportControl, type ServiceTransportRef } from '../../../../../../../packages/contracts/src/desktop-service-transports'
import type { TransportDependencies, TransportReceiptKey } from './types'
export const SERVICE_TRANSPORT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_service_transport_receipts (
 owner TEXT NOT NULL, installation_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, identity TEXT NOT NULL,
 engine_id TEXT, session_id TEXT, run_id TEXT, call_id TEXT, receipt TEXT,
 PRIMARY KEY(owner,request_id), UNIQUE(owner,installation_id,engine_id,session_id,run_id,call_id)
);
CREATE TABLE IF NOT EXISTS desktop_service_transport_pending (
 owner TEXT NOT NULL, installation_id TEXT NOT NULL, request_id TEXT NOT NULL, request TEXT NOT NULL,
 PRIMARY KEY(owner,installation_id)
);`
const identity = (key: TransportReceiptKey) => JSON.stringify([key.ref.agentId, key.ref.key, key.ref.installationId, key.ref.revision, key.requestId, key.action, key.run?.engineAgentId, key.run?.sessionId, key.run?.runId, key.toolCallId])
export function serviceTransportStore(db: Client) {
    const receipts: TransportDependencies['receipts'] = {
        async claim(key, fingerprint, signal) {
            signal.throwIfAborted()
            const inserted = await db.execute({ sql: `INSERT INTO desktop_service_transport_receipts(owner,installation_id,request_id,fingerprint,identity,engine_id,session_id,run_id,call_id)
                SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM desktop_service_transport_receipts WHERE owner=?)<100000 ON CONFLICT DO NOTHING`,
                args: [key.ref.agentId, key.ref.installationId, key.requestId, fingerprint, identity(key), key.run?.engineAgentId ?? null, key.run?.sessionId ?? null, key.run?.runId ?? null, key.toolCallId ?? null, key.ref.agentId] })
            signal.throwIfAborted()
            if (inserted.rowsAffected === 1) return 'new'
            const row = (await db.execute({ sql: 'SELECT fingerprint,identity FROM desktop_service_transport_receipts WHERE owner=? AND request_id=?', args: [key.ref.agentId, key.requestId] })).rows[0]
            if (!row || row.fingerprint !== fingerprint || row.identity !== identity(key)) throw new Error('Transport request identity conflict.')
            return 'existing'
        },
        async read(key, signal) {
            signal.throwIfAborted()
            const row = (await db.execute({ sql: 'SELECT receipt,identity FROM desktop_service_transport_receipts WHERE owner=? AND request_id=?', args: [key.ref.agentId, key.requestId] })).rows[0]
            signal.throwIfAborted()
            if (!row || row.identity !== identity(key) || !row.receipt) return null
            return serviceTransportReceiptSchema.parse(JSON.parse(String(row.receipt)))
        },
        async settle(key, fingerprint, receipt) {
            const parsed = serviceTransportReceiptSchema.parse(receipt)
            if (parsed.ref.agentId !== key.ref.agentId || parsed.ref.key !== key.ref.key || parsed.ref.installationId !== key.ref.installationId || parsed.ref.revision !== key.ref.revision || parsed.requestId !== key.requestId || parsed.action !== key.action) throw new Error('Transport receipt identity conflict.')
            const encoded = JSON.stringify(parsed), retryClose = key.action === 'stop' || key.action === 'disconnect'
            const updated = await db.execute({ sql: `UPDATE desktop_service_transport_receipts SET receipt=? WHERE owner=? AND request_id=? AND fingerprint=? AND identity=? AND (receipt IS NULL OR receipt=? ${retryClose ? "OR json_extract(receipt,'$.outcome')='uncertain'" : ''})`, args: [encoded, key.ref.agentId, key.requestId, fingerprint, identity(key), encoded] })
            if (updated.rowsAffected !== 1) throw new Error('Transport receipt is immutable or belongs to another invocation.')
        },
    }
    const pending = {
        async read(ref: ServiceTransportRef) {
            const row = (await db.execute({ sql: 'SELECT request FROM desktop_service_transport_pending WHERE owner=? AND installation_id=?', args: [ref.agentId, ref.installationId] })).rows[0]
            return row ? serviceTransportControlSchema.parse(JSON.parse(String(row.request))) : null
        },
        async put(raw: ServiceTransportControl) {
            const request = serviceTransportControlSchema.parse(raw), encoded = JSON.stringify(request)
            await db.execute({ sql: 'INSERT INTO desktop_service_transport_pending(owner,installation_id,request_id,request) VALUES(?,?,?,?) ON CONFLICT DO NOTHING', args: [request.agentId, request.installationId, request.requestId, encoded] })
            if (JSON.stringify(await pending.read(request)) !== encoded) throw new Error('Reconcile the current transport attempt first.')
        },
        async clear(raw: ServiceTransportControl) {
            const request = serviceTransportControlSchema.parse(raw)
            await db.execute({ sql: 'DELETE FROM desktop_service_transport_pending WHERE owner=? AND installation_id=? AND request_id=? AND request=?', args: [request.agentId, request.installationId, request.requestId, JSON.stringify(request)] })
        },
    }
    return { receipts, pending }
}
