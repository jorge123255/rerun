import 'server-only'

import type { Client } from '@libsql/client'
import { DESKTOP_SERVICE_ACCOUNT_MESSAGES as M, type DesktopServiceAccountResult } from '../../../../../../../packages/contracts/src/desktop-service-accounts'
import { ensureDesktopServiceAccountSchema } from './schema'

export type ReservationPhase = 'reserved' | 'allocated' | 'sealed' | 'published' | 'probing' | 'mutating' | 'complete'

export type AccountReservation = {
    owner: string
    requestId: string
    fingerprint: string
    phase: ReservationPhase
    accountKey: string | null
    installationId: string | null
    revision: string | null
    publicResult: DesktopServiceAccountResult | null
    createdAt: string
}

export interface ReservationPort {
    begin(owner: string, requestId: string, fingerprint: string, createdAt: string): Promise<AccountReservation>
    save(current: AccountReservation, expectedPhase: ReservationPhase): Promise<void>
    list(owner: string): Promise<AccountReservation[]>
    tombstones(owner: string): Promise<string[]>
    tombstone(owner: string, accountKey: string, at: string): Promise<void>
}

function asResult(value: string | null): DesktopServiceAccountResult | null {
    if (!value) return null
    return JSON.parse(value) as DesktopServiceAccountResult
}

export function memoryReservations(): ReservationPort {
    const rows = new Map<string, AccountReservation>()
    const retired = new Map<string, Set<string>>()
    const id = (owner: string, requestId: string) => `${owner}\0${requestId}`
    return {
        async begin(owner, requestId, fingerprint, createdAt) {
            const key = id(owner, requestId)
            const existing = rows.get(key)
            if (existing) {
                if (existing.fingerprint !== fingerprint) throw new Error(M.reused)
                return { ...existing }
            }
            const created: AccountReservation = { owner, requestId, fingerprint, phase: 'reserved', accountKey: null, installationId: null, revision: null, publicResult: null, createdAt }
            rows.set(key, created)
            return { ...created }
        },
        async save(current, expectedPhase) {
            const key = id(current.owner, current.requestId)
            const existing = rows.get(key)
            if (!existing || existing.fingerprint !== current.fingerprint || existing.phase !== expectedPhase) throw new Error(M.revision)
            rows.set(key, { ...current })
        },
        async list(owner) {
            return [...rows.values()].filter(row => row.owner === owner).map(row => ({ ...row }))
        },
        async tombstones(owner) {
            return [...(retired.get(owner) ?? [])]
        },
        async tombstone(owner, accountKey, _at) {
            const set = retired.get(owner) ?? new Set<string>()
            set.add(accountKey)
            retired.set(owner, set)
        },
    }
}

function fromRow(row: Record<string, unknown>): AccountReservation {
    return {
        owner: String(row.owner),
        requestId: String(row.request_id),
        fingerprint: String(row.fingerprint),
        phase: String(row.phase) as ReservationPhase,
        accountKey: row.account_key ? String(row.account_key) : null,
        installationId: row.installation_id ? String(row.installation_id) : null,
        revision: row.revision ? String(row.revision) : null,
        publicResult: asResult(row.public_result ? String(row.public_result) : null),
        createdAt: String(row.created_at),
    }
}

export function sqliteReservations(db: Client): ReservationPort {
    let ready: Promise<void> | null = null
    const schema = () => ready ?? (ready = ensureDesktopServiceAccountSchema(db))
    return {
        async begin(owner, requestId, fingerprint, createdAt) {
            await schema()
            const inserted = await db.execute({
                sql: `INSERT INTO desktop_service_account_mutations(owner, request_id, fingerprint, phase, created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`,
                args: [owner, requestId, fingerprint, 'reserved', createdAt],
            })
            const row = (await db.execute({ sql: 'SELECT * FROM desktop_service_account_mutations WHERE owner=? AND request_id=?', args: [owner, requestId] })).rows[0]
            if (!row) throw new Error(M.revision)
            const reservation = fromRow(row as Record<string, unknown>)
            if (reservation.fingerprint !== fingerprint) throw new Error(M.reused)
            if (inserted.rowsAffected !== 1 && reservation.phase === 'reserved' && reservation.fingerprint === fingerprint) return reservation
            return reservation
        },
        async save(current, expectedPhase) {
            await schema()
            const result = await db.execute({
                sql: `UPDATE desktop_service_account_mutations SET phase=?, account_key=?, installation_id=?, revision=?, public_result=? WHERE owner=? AND request_id=? AND fingerprint=? AND phase=?`,
                args: [current.phase, current.accountKey, current.installationId, current.revision, current.publicResult ? JSON.stringify(current.publicResult) : null, current.owner, current.requestId, current.fingerprint, expectedPhase],
            })
            if (result.rowsAffected !== 1) throw new Error(M.revision)
        },
        async list(owner) {
            await schema()
            const rows = (await db.execute({ sql: 'SELECT * FROM desktop_service_account_mutations WHERE owner=?', args: [owner] })).rows
            return rows.map(row => fromRow(row as Record<string, unknown>))
        },
        async tombstones(owner) {
            await schema()
            const rows = (await db.execute({ sql: 'SELECT account_key FROM desktop_service_account_tombstones WHERE owner=?', args: [owner] })).rows
            return rows.map(row => String(row.account_key))
        },
        async tombstone(owner, accountKey, at) {
            await schema()
            await db.execute({ sql: 'INSERT INTO desktop_service_account_tombstones(owner, account_key, retired_at) VALUES(?,?,?) ON CONFLICT DO NOTHING', args: [owner, accountKey, at] })
        },
    }
}
