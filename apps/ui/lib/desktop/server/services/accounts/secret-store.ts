import 'server-only'

import type { Client } from '@libsql/client'
import { DESKTOP_SERVICE_ACCOUNT_MESSAGES as M } from '@rerun/contracts'
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


/** Read old bearer records in place until a reviewed reconfigure publishes a new bundle. */
export function legacyCompatibleHeaderSecrets(store: import('../store').ServiceStore, headers: HeaderSecretPort): HeaderSecretPort {
    const legacy = async (owner: string, installationId: string) => {
        if (await headers.has(owner, installationId)) return null
        const row = (await store.list(owner)).find(item => item.id === installationId)
        return row && !('shape' in row.plan) && row.plan.secretInput && row.configured ? row : null
    }
    return {
        ...headers,
        async has(owner, installationId) {
            return await headers.has(owner, installationId) || !!await legacy(owner, installationId)
        },
        async write(input) {
            if (input.expectedRevision !== null && !await headers.has(input.owner, input.installationId)) {
                const row = await legacy(input.owner, input.installationId)
                if (!row || row.revision !== input.expectedRevision) throw new Error(M.secretConflict)
                return headers.write({ ...input, expectedRevision: null })
            }
            return headers.write(input)
        },
        async read(owner, installationId, revision) {
            const current = await headers.read(owner, installationId, revision)
            if (current) return current
            const row = await legacy(owner, installationId)
            if (!row || row.revision !== revision) return null
            const bearer = await store.credential(owner, installationId)
            const latest = await store.read(owner, row.key)
            if (!bearer || !latest || latest.id !== installationId || latest.revision !== revision || 'shape' in latest.plan) return null
            return { headers: { Authorization: `Bearer ${bearer}` }, inputs: { [row.plan.secretInput!]: bearer } }
        },
    }
}
