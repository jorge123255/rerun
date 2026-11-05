import 'server-only'

import type { Client } from '@libsql/client'
import { DESKTOP_SERVICE_ACCOUNT_MESSAGES as M } from '../../../../../../../packages/contracts/src/desktop-service-accounts'
import { bundlesMatch, openStoredHeaderBundle, sealHeaderBundle, type HeaderSecretBundle } from './header-secret-codec'
import { ensureDesktopServiceAccountSchema } from './schema'

export type HeaderSecretWrite = {
    owner: string
    installationId: string
    expectedRevision: string | null
    revision: string
    bundle: HeaderSecretBundle
}

export type SecretWriteDecision = 'insert' | 'unchanged' | 'replace' | 'conflict'

/** Pure transition shared by the sqlite adapter and tests. */
export function secretWriteDecision(current: { revision: string } | null, input: { expectedRevision: string | null; revision: string; samePlaintext: boolean }): SecretWriteDecision {
    if (!current) return input.expectedRevision === null ? 'insert' : 'conflict'
    if (current.revision === input.revision) return input.samePlaintext ? 'unchanged' : 'conflict'
    if (input.expectedRevision !== null && current.revision === input.expectedRevision) return 'replace'
    return 'conflict'
}

export interface HeaderSecretPort {
    read(owner: string, installationId: string, revision: string): Promise<HeaderSecretBundle | null>
    has(owner: string, installationId: string): Promise<boolean>
    write(input: HeaderSecretWrite): Promise<void>
    remove(owner: string, installationId: string, revision: string): Promise<void>
}

type MemoryRow = { revision: string; bundle: HeaderSecretBundle }

export function memoryHeaderSecrets(): HeaderSecretPort {
    const rows = new Map<string, MemoryRow>()
    const id = (owner: string, installationId: string) => `${owner}\0${installationId}`
    return {
        async read(owner, installationId, revision) {
            const row = rows.get(id(owner, installationId))
            return row && row.revision === revision ? { headers: { ...row.bundle.headers }, inputs: { ...row.bundle.inputs } } : null
        },
        async has(owner, installationId) {
            return rows.has(id(owner, installationId))
        },
        async write(input) {
            const key = id(input.owner, input.installationId)
            const current = rows.get(key) ?? null
            const decision = secretWriteDecision(current, { expectedRevision: input.expectedRevision, revision: input.revision, samePlaintext: current ? bundlesMatch(current.bundle, input.bundle) : false })
            if (decision === 'conflict') throw new Error(M.secretConflict)
            if (decision === 'unchanged') return
            rows.set(key, { revision: input.revision, bundle: { headers: { ...input.bundle.headers }, inputs: { ...input.bundle.inputs } } })
        },
        async remove(owner, installationId, revision) {
            const key = id(owner, installationId)
            const current = rows.get(key)
            if (!current) return
            if (current.revision !== revision) throw new Error(M.secretConflict)
            rows.delete(key)
        },
    }
}

export function sqliteHeaderSecrets(db: Client, keyReader: () => Buffer): HeaderSecretPort {
    let ready: Promise<void> | null = null
    const schema = () => ready ?? (ready = ensureDesktopServiceAccountSchema(db))
    async function current(owner: string, installationId: string): Promise<{ revision: string; bundle: string } | null> {
        await schema()
        const row = (await db.execute({ sql: 'SELECT revision, bundle FROM desktop_service_header_secrets WHERE owner=? AND installation_id=?', args: [owner, installationId] })).rows[0]
        return row ? { revision: String(row.revision), bundle: String(row.bundle) } : null
    }
    return {
        async read(owner, installationId, revision) {
            const row = await current(owner, installationId)
            if (!row || row.revision !== revision) return null
            return openStoredHeaderBundle(keyReader(), owner, installationId, revision, row.bundle)
        },
        async has(owner, installationId) {
            return (await current(owner, installationId)) !== null
        },
        async write(input) {
            const row = await current(input.owner, input.installationId)
            let same = false
            if (row && row.revision === input.revision) {
                try {
                    same = bundlesMatch(openStoredHeaderBundle(keyReader(), input.owner, input.installationId, input.revision, row.bundle), input.bundle)
                } catch {
                    throw new Error(M.secretConflict)
                }
            }
            const decision = secretWriteDecision(row, { expectedRevision: input.expectedRevision, revision: input.revision, samePlaintext: same })
            if (decision === 'conflict') throw new Error(M.secretConflict)
            if (decision === 'unchanged') return
            const sealed = sealHeaderBundle(keyReader(), input.owner, input.installationId, input.revision, input.bundle)
            if (decision === 'insert') {
                const result = await db.execute({ sql: 'INSERT INTO desktop_service_header_secrets(owner, installation_id, revision, bundle) VALUES(?,?,?,?)', args: [input.owner, input.installationId, input.revision, sealed] })
                if (result.rowsAffected !== 1) throw new Error(M.secretConflict)
                return
            }
            const result = await db.execute({
                sql: 'UPDATE desktop_service_header_secrets SET revision=?, bundle=? WHERE owner=? AND installation_id=? AND revision=?',
                args: [input.revision, sealed, input.owner, input.installationId, input.expectedRevision],
            })
            if (result.rowsAffected !== 1) throw new Error(M.secretConflict)
        },
        async remove(owner, installationId, revision) {
            const row = await current(owner, installationId)
            if (!row) return
            if (row.revision !== revision) throw new Error(M.secretConflict)
            const result = await db.execute({ sql: 'DELETE FROM desktop_service_header_secrets WHERE owner=? AND installation_id=? AND revision=?', args: [owner, installationId, revision] })
            if (result.rowsAffected !== 1) throw new Error(M.secretConflict)
        },
    }
}
