import type { Client, Transaction } from '@libsql/client'
import {
    desktopCompanyProfileAttemptSchema,
    type DesktopCompanyProfileAttempt,
    type DesktopForemanChatRef,
} from '@rerun/contracts'
import { DesktopCompanyProfileError } from './errors'
import { desktopCompanyProfileAttemptFingerprint } from './identity'
import { ensureDesktopCompanyProfileSchema } from './schema'

export type StoredDesktopCompanyProfileAttempt = { attempt: DesktopCompanyProfileAttempt; fingerprint: string }

export type DesktopCompanyProfileStore = {
    get(requestId: string): Promise<StoredDesktopCompanyProfileAttempt | null>
    latest(chat: DesktopForemanChatRef, kind: 'decide' | 'enrich'): Promise<DesktopCompanyProfileAttempt | null>
    insert(attempt: DesktopCompanyProfileAttempt, fingerprint?: string): Promise<'inserted' | 'exists'>
    updateProgress(attempt: DesktopCompanyProfileAttempt): Promise<boolean>
    settle(attempt: DesktopCompanyProfileAttempt): Promise<boolean>
    pending(): Promise<DesktopCompanyProfileAttempt[]>
}

const clone = <T>(value: T): T => structuredClone(value)

export function createMemoryDesktopCompanyProfileStore(): DesktopCompanyProfileStore {
    const rows = new Map<string, StoredDesktopCompanyProfileAttempt>()
    return {
        async get(requestId) {
            const row = rows.get(requestId)
            return row ? clone(row) : null
        },
        async latest(chat, kind) {
            const matches = [...rows.values()].filter(row => row.attempt.kind === kind
                && row.attempt.identity.chat.workspaceId === chat.workspaceId && row.attempt.identity.chat.chatId === chat.chatId)
            matches.sort((a, b) => a.attempt.updatedAt.localeCompare(b.attempt.updatedAt) || a.attempt.requestId.localeCompare(b.attempt.requestId))
            return matches.length ? clone(matches[matches.length - 1].attempt) : null
        },
        async insert(attempt, fingerprint = desktopCompanyProfileAttemptFingerprint(attempt)) {
            if (rows.has(attempt.requestId)) return 'exists'
            rows.set(attempt.requestId, { attempt: clone(attempt), fingerprint })
            return 'inserted'
        },
        async updateProgress(attempt) {
            const row = rows.get(attempt.requestId)
            if (!row || row.attempt.status !== 'pending' || attempt.status !== 'pending') return false
            rows.set(attempt.requestId, { ...row, attempt: clone(attempt) })
            return true
        },
        async settle(attempt) {
            const row = rows.get(attempt.requestId)
            if (!row || row.attempt.status !== 'pending' || attempt.status === 'pending') return false
            rows.set(attempt.requestId, { ...row, attempt: clone(attempt) })
            return true
        },
        async pending() {
            return [...rows.values()].filter(row => row.attempt.status === 'pending').map(row => clone(row.attempt))
        },
    }
}

const WRITES = Symbol.for('rerun.desktop.company-profile.writes.v1')
const writes = () => ((globalThis as unknown as Record<symbol, { tail: Promise<unknown> }>)[WRITES] ??= { tail: Promise.resolve() })
function serialized<T>(work: () => Promise<T>): Promise<T> {
    const queue = writes()
    const result = queue.tail.catch(() => {}).then(work)
    queue.tail = result.catch(() => {})
    return result
}

type Executor = Pick<Transaction, 'execute'>

function parseRow(row: Record<string, unknown>): StoredDesktopCompanyProfileAttempt {
    try {
        const attempt = desktopCompanyProfileAttemptSchema.parse(JSON.parse(String(row.body)))
        if (attempt.requestId !== String(row.request_id) || attempt.kind !== String(row.kind)
            || attempt.identity.chat.workspaceId !== String(row.workspace_id) || attempt.identity.chat.chatId !== String(row.chat_id)
            || attempt.createdAt !== String(row.created_at) || attempt.updatedAt !== String(row.updated_at)) throw new Error('identity')
        return { attempt, fingerprint: String(row.fingerprint) }
    } catch {
        throw new DesktopCompanyProfileError('storage', 'A saved company profile attempt could not be confirmed.')
    }
}

async function getWith(executor: Executor, requestId: string): Promise<StoredDesktopCompanyProfileAttempt | null> {
    const row = (await executor.execute({ sql: 'SELECT * FROM desktop_company_profile_attempts WHERE request_id=?', args: [requestId] })).rows[0]
    return row ? parseRow(row) : null
}

export function createSqliteDesktopCompanyProfileStore(db: Client, options?: { schemaReady?: boolean }): DesktopCompanyProfileStore {
    let ready: Promise<void> | null = options?.schemaReady ? Promise.resolve() : null
    const ensure = () => (ready ??= serialized(() => ensureDesktopCompanyProfileSchema(db)))
    async function write<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
        return serialized(async () => {
            const tx = await db.transaction('write')
            try { const value = await work(tx); await tx.commit(); return value }
            catch (error) { await tx.rollback().catch(() => {}); throw error }
            finally { tx.close() }
        })
    }
    return {
        async get(requestId) { await ensure(); return getWith(db, requestId) },
        async latest(chat, kind) {
            await ensure()
            const row = (await db.execute({
                sql: 'SELECT * FROM desktop_company_profile_attempts WHERE workspace_id=? AND chat_id=? AND kind=? ORDER BY updated_at DESC,rowid DESC LIMIT 1',
                args: [chat.workspaceId, chat.chatId, kind],
            })).rows[0]
            return row ? parseRow(row).attempt : null
        },
        async insert(attempt, fingerprint = desktopCompanyProfileAttemptFingerprint(attempt)) {
            await ensure()
            return write(async tx => {
                try {
                    await tx.execute({
                        sql: 'INSERT INTO desktop_company_profile_attempts(request_id,workspace_id,chat_id,kind,fingerprint,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
                        args: [attempt.requestId, attempt.identity.chat.workspaceId, attempt.identity.chat.chatId, attempt.kind, fingerprint, JSON.stringify(attempt), attempt.createdAt, attempt.updatedAt],
                    })
                    return 'inserted' as const
                } catch (error) {
                    if (/UNIQUE|constraint/i.test(error instanceof Error ? error.message : String(error))) return 'exists' as const
                    throw error
                }
            })
        },
        async updateProgress(attempt) {
            await ensure()
            if (attempt.status !== 'pending') return false
            return write(async tx => {
                const result = await tx.execute({
                    sql: "UPDATE desktop_company_profile_attempts SET body=?,updated_at=? WHERE request_id=? AND json_extract(body,'$.status')='pending'",
                    args: [JSON.stringify(attempt), attempt.updatedAt, attempt.requestId],
                })
                return result.rowsAffected === 1
            })
        },
        async settle(attempt) {
            await ensure()
            if (attempt.status === 'pending') return false
            return write(async tx => {
                const result = await tx.execute({
                    sql: "UPDATE desktop_company_profile_attempts SET body=?,updated_at=? WHERE request_id=? AND json_extract(body,'$.status')='pending'",
                    args: [JSON.stringify(attempt), attempt.updatedAt, attempt.requestId],
                })
                return result.rowsAffected === 1
            })
        },
        async pending() {
            await ensure()
            const rows = (await db.execute("SELECT * FROM desktop_company_profile_attempts WHERE json_extract(body,'$.status')='pending'")).rows
            return rows.map(row => parseRow(row).attempt)
        },
    }
}
