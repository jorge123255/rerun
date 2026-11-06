import type { Client } from '@libsql/client'
import { z } from 'zod'
import { raw } from '../../db/client.js'
import { launcherOperationSchema } from './contract.js'
import { createLauncherAttemptStore, type LauncherTransaction } from './store.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const outcome = z.object({ requestId: z.string(), app: z.enum(['terminal', 'files']), status: z.enum(['opened', 'focused', 'interrupted', 'app-missing', 'timeout']), acknowledged: z.boolean() }).strict()
const recordSchema = z.object({ version: z.literal(1), operation: launcherOperationSchema, fingerprint: hash, operationId: hash, phase: z.enum(['reserved', 'submitted', 'settled']), outcome: outcome.nullable() }).strict()
export const computerLauncherSchema = `CREATE TABLE IF NOT EXISTS desktop_computer_launcher_attempts (
 key TEXT PRIMARY KEY, owner TEXT NOT NULL, generation TEXT NOT NULL, record TEXT NOT NULL
)`

// The local SQLite client opens a separate connection for each write transaction.
// Serialize this ledger per client so a second begin cannot starve the first commit.
const transactions = new WeakMap<Client, Promise<void>>()
export function sqliteLauncherStore(database: Client) {
    const transaction: LauncherTransaction = async (key, work) => {
        const previousWork = transactions.get(database) ?? Promise.resolve()
        let release!: () => void
        const finished = new Promise<void>(resolve => { release = resolve })
        const tail = previousWork.catch(() => {}).then(() => finished)
        transactions.set(database, tail)
        await previousWork.catch(() => {})
        let tx
        try { tx = await database.transaction('write') }
        catch (error) { release(); if (transactions.get(database) === tail) transactions.delete(database); throw error }
        try {
            const row = (await tx.execute({ sql: 'SELECT record FROM desktop_computer_launcher_attempts WHERE key=?', args: [key] })).rows[0]
            const previous = row ? recordSchema.parse(JSON.parse(String(row.record))) : null
            const { value, result } = work(previous)
            const saved = recordSchema.parse(value)
            if (key !== `computer-launcher:${saved.operation.requestId}`) throw new Error('Launcher identity changed')
            if (!previous) {
                const count = (await tx.execute({ sql: 'SELECT COUNT(*) AS n FROM desktop_computer_launcher_attempts WHERE owner=? AND generation=?', args: [saved.operation.agentId, saved.operation.generation] })).rows[0]
                const total = (await tx.execute('SELECT COUNT(*) AS n FROM desktop_computer_launcher_attempts')).rows[0]
                if (Number(count.n) >= 256 || Number(total.n) >= 16384) throw new Error('Launcher receipt limit reached')
                await tx.execute({ sql: 'INSERT INTO desktop_computer_launcher_attempts(key,owner,generation,record) VALUES(?,?,?,?)', args: [key, saved.operation.agentId, saved.operation.generation, JSON.stringify(saved)] })
            } else {
                if (previous.fingerprint !== saved.fingerprint || previous.operationId !== saved.operationId || JSON.stringify(previous.operation) !== JSON.stringify(saved.operation)) throw new Error('Launcher receipt changed')
                const updated = await tx.execute({ sql: 'UPDATE desktop_computer_launcher_attempts SET record=? WHERE key=? AND record=?', args: [JSON.stringify(saved), key, String(row!.record)] })
                if (updated.rowsAffected !== 1) throw new Error('Launcher receipt changed')
            }
            await tx.commit()
            return result
        } catch (error) { await tx.rollback().catch(() => {}); throw error }
        finally { tx.close(); release(); if (transactions.get(database) === tail) transactions.delete(database) }
    }
    return createLauncherAttemptStore(transaction)
}
let installed: ReturnType<typeof sqliteLauncherStore> | undefined
export async function initializeComputerLaunchers(database: Client = raw()) {
    await database.execute(computerLauncherSchema)
    installed = sqliteLauncherStore(database)
}
export function computerLauncherStore() {
    if (!installed) throw new Error('Computer launcher receipts are unavailable')
    return installed
}
