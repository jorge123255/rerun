import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import type { Client } from '@libsql/client'
import {
    customProviderChangeSchema, customProviderIdentitySchema, customProviderReceiptSchema, customProviderSnapshotSchema,
    registeredCustomConnectionIdSchema as idSchema, type BoxDefaultModel, type CustomProviderAuthority, type CustomProviderIdentity, type CustomProviderSnapshot,
} from '@rerun/contracts'
import { withKeyedLock } from '../../lib/lock.js'
import { endpointBase } from './network.js'

export const DESKTOP_CUSTOM_CONNECTIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_custom_connections (
 workspace_id INTEGER NOT NULL, connection_id TEXT NOT NULL, snapshot TEXT NOT NULL,
 ciphertext TEXT, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,connection_id)
);
CREATE TABLE IF NOT EXISTS desktop_custom_connection_receipts (
 workspace_id INTEGER NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 receipt TEXT NOT NULL, PRIMARY KEY(workspace_id,request_id)
);`

export const isCustomConnectionId = (id: string) => idSchema.safeParse(id).success
export const withCustomConnectionWrite = <T>(workspaceId: number, work: () => Promise<T>) => withKeyedLock(`desktop-custom-connection:${workspaceId}`, work)
const emptyCatalog: CustomProviderSnapshot['catalog'] = { status: 'never', models: [], observedAt: null, attemptedAt: null }
const scope = (identity: CustomProviderIdentity) => Buffer.from(JSON.stringify(['desktop-custom-connection-v1', identity.workspaceId, identity.connectionId, identity.revision]))
const derive = (key: Buffer, purpose: string) => createHmac('sha256', key).update(`rerun-desktop-custom:${purpose}:v1`).digest()

function seal(secret: string, key: Buffer, identity: CustomProviderIdentity): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', derive(key, 'cipher'), iv)
    cipher.setAAD(scope(identity))
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}

function unseal(ciphertext: string, key: Buffer, identity: CustomProviderIdentity): string {
    const data = Buffer.from(ciphertext, 'base64')
    if (data.length < 29) throw new Error('Custom credential is unavailable.')
    const decipher = createDecipheriv('aes-256-gcm', derive(key, 'cipher'), data.subarray(0, 12))
    decipher.setAAD(scope(identity))
    decipher.setAuthTag(data.subarray(12, 28))
    const clear = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()])
    try { return clear.toString('utf8') }
    finally { clear.fill(0) }
}

type Options = {
    db: Client
    workspaceId: number
    key: () => Buffer
    assertActive: () => void
    readDefault: () => Promise<BoxDefaultModel | null>
    idExists: (id: string) => boolean
    changed: (id: string) => void
}

export function createCustomConnectionStore({ db, workspaceId, key, assertActive, readDefault, idExists, changed }: Options) {
    const listeners = new Set<Parameters<CustomProviderAuthority['subscribe']>[0]>()
    function active(signal: AbortSignal) { signal.throwIfAborted(); assertActive() }
    function identityOf(identity: CustomProviderIdentity) {
        if (identity.workspaceId !== workspaceId || !isCustomConnectionId(identity.connectionId)) throw new Error('Custom connection is outside this workspace.')
        return customProviderIdentitySchema.parse(identity)
    }

    async function row(connectionId: string, reader: Pick<Client, 'execute'> = db) {
        const result = await reader.execute({ sql: 'SELECT snapshot,ciphertext,created_at FROM desktop_custom_connections WHERE workspace_id=? AND connection_id=?', args: [workspaceId, connectionId] })
        const saved = result.rows[0]
        if (!saved) return null
        const snapshot = customProviderSnapshotSchema.parse(JSON.parse(String(saved.snapshot)))
        if (snapshot.workspaceId !== workspaceId || snapshot.connectionId !== connectionId || snapshot.configuredSecret !== (saved.ciphertext !== null)) throw new Error('Custom connection identity changed.')
        return { snapshot, ciphertext: saved.ciphertext === null ? null : String(saved.ciphertext), createdAt: String(saved.created_at) }
    }

    async function exact(raw: CustomProviderIdentity, signal: AbortSignal) {
        active(signal)
        const identity = identityOf(raw)
        const found = await row(identity.connectionId)
        active(signal)
        if (!found || found.snapshot.revision !== identity.revision) throw new Error('Custom connection changed.')
        return found
    }

    const authority: CustomProviderAuthority = {
        async read(identity, signal) { return (await exact(identity, signal)).snapshot },
        async assertCurrent(identity, signal) { await exact(identity, signal) },
        async credential(identity, signal) {
            const found = await exact(identity, signal)
            if (found.snapshot.state !== 'configured') throw new Error('Custom connection is unavailable.')
            return found.ciphertext ? unseal(found.ciphertext, key(), identity) : null
        },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
        async change(raw, signal) {
            const change = customProviderChangeSchema.parse(raw)
            const connectionId = change.action === 'create' ? idSchema.parse(change.connectionId) : identityOf(change.identity).connectionId
            if (change.action === 'create' && change.workspaceId !== workspaceId) throw new Error('Custom connection is outside this workspace.')
            const custodyKey = key()
            const fingerprint = createHmac('sha256', derive(custodyKey, 'receipt')).update(JSON.stringify(change)).digest('hex')
            return withCustomConnectionWrite(workspaceId, async () => {
                active(signal)
                const tx = await db.transaction('write')
                try {
                    const replay = (await tx.execute({ sql: 'SELECT fingerprint,receipt FROM desktop_custom_connection_receipts WHERE workspace_id=? AND request_id=?', args: [workspaceId, change.requestId] })).rows[0]
                    if (replay) {
                        if (replay.fingerprint !== fingerprint) throw new Error('Custom request identity changed.')
                        return { ...customProviderReceiptSchema.parse(JSON.parse(String(replay.receipt))), recovered: true }
                    }
                    const before = await row(connectionId, tx)
                    if (change.action === 'create' ? before || idExists(connectionId) : !before || before.snapshot.revision !== change.identity.revision || before.snapshot.state !== 'configured') throw new Error('Custom connection changed.')
                    const config = change.action === 'disconnect' ? before!.snapshot.config : change.config
                    endpointBase(config)
                    if (new Set(config.models.map(model => model.id)).size !== config.models.length) throw new Error('Choose each custom model once.')
                    const selected = await readDefault()
                    if (selected?.connectionId === connectionId && (change.action === 'disconnect' || !config.models.some(model => model.id === selected.model))) throw new Error('Choose a different workspace default first.')
                    const identity = { workspaceId, connectionId, revision: (before?.snapshot.revision ?? 0) + 1 }
                    const previous = before?.snapshot
                    const baseChanged = previous && endpointBase(previous.config) !== endpointBase(config)
                    let secret: string | null = null
                    if (change.action !== 'disconnect') {
                        if (change.action === 'update' && change.clearSecret && change.apiKey !== undefined) throw new Error('Choose one credential change.')
                        if (change.apiKey !== undefined) {
                            secret = change.apiKey.trim()
                            if (!secret || !/^[\x21-\x7e]+$/.test(secret)) throw new Error('Enter a valid API key.')
                        } else if (before?.ciphertext && !(change.action === 'update' && change.clearSecret)) {
                            if (new URL(previous!.config.baseUrl).origin !== new URL(config.baseUrl).origin) throw new Error('Review the new origin and replace or clear its credential.')
                            secret = unseal(before.ciphertext, custodyKey, previous!)
                        }
                    }
                    const authChanged = change.action === 'disconnect' || change.apiKey !== undefined || change.action === 'update' && change.clearSecret
                    const snapshot: CustomProviderSnapshot = { ...identity, config, state: change.action === 'disconnect' ? 'disconnected' : 'configured',
                        configuredSecret: secret !== null, catalog: baseChanged || authChanged ? emptyCatalog : previous?.catalog ?? emptyCatalog }
                    const ciphertext = secret === null ? null : seal(secret, custodyKey, identity)
                    const receipt = customProviderReceiptSchema.parse({ requestId: change.requestId, identity, action: change.action, status: 'recorded', recovered: false })
                    active(signal)
                    await tx.execute({ sql: `INSERT INTO desktop_custom_connections(workspace_id,connection_id,snapshot,ciphertext,created_at) VALUES(?,?,?,?,?)
                        ON CONFLICT(workspace_id,connection_id) DO UPDATE SET snapshot=excluded.snapshot,ciphertext=excluded.ciphertext`,
                        args: [workspaceId, connectionId, JSON.stringify(snapshot), ciphertext, before?.createdAt ?? new Date().toISOString()] })
                    await tx.execute({ sql: 'INSERT INTO desktop_custom_connection_receipts(workspace_id,request_id,fingerprint,receipt) VALUES(?,?,?,?)',
                        args: [workspaceId, change.requestId, fingerprint, JSON.stringify(receipt)] })
                    active(signal)
                    await tx.commit()
                    changed(connectionId)
                    for (const notify of listeners) notify(identity)
                    return receipt
                } finally { tx.close() }
            })
        },
        async recordProbe(raw, result, signal) {
            const identity = identityOf(raw)
            if (result.identity.workspaceId !== workspaceId || result.identity.connectionId !== identity.connectionId || result.identity.revision !== identity.revision) throw new Error('Custom probe identity changed.')
            await withCustomConnectionWrite(workspaceId, async () => {
                const { snapshot } = await exact(identity, signal)
                if (snapshot.state !== 'configured') throw new Error('Custom connection is unavailable.')
                if ((snapshot.catalog.attemptedAt ?? 0) > result.observedAt) return
                const fresh = result.status !== 'unavailable'
                const catalog: CustomProviderSnapshot['catalog'] = fresh
                    ? { status: result.status, models: result.models, observedAt: result.observedAt, attemptedAt: result.observedAt }
                    : { ...snapshot.catalog, status: snapshot.catalog.observedAt === null ? 'unavailable' : 'stale', attemptedAt: result.observedAt }
                active(signal)
                await db.execute({ sql: 'UPDATE desktop_custom_connections SET snapshot=? WHERE workspace_id=? AND connection_id=?',
                    args: [JSON.stringify({ ...snapshot, catalog }), workspaceId, identity.connectionId] })
            })
        },
    }
    return {
        authority, row,
        async ids() {
            return (await db.execute({ sql: "SELECT connection_id FROM desktop_custom_connections WHERE workspace_id=? AND json_extract(snapshot,'$.state')='configured' ORDER BY created_at,connection_id", args: [workspaceId] })).rows.map(r => String(r.connection_id))
        },
    }
}
