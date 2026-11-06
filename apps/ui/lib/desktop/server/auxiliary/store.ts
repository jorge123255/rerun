import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { desktopAuxiliaryChangeSchema, desktopAuxiliaryPurposes, type DesktopAuxiliaryPurpose, type DesktopAuxiliaryStatus } from '../../auxiliary'

export const desktopAuxiliarySchema = `CREATE TABLE IF NOT EXISTS desktop_auxiliary_credentials (
 purpose TEXT PRIMARY KEY CHECK(purpose IN ('search','embedding','transcription')),
 revision TEXT NOT NULL, ciphertext TEXT);
CREATE TABLE IF NOT EXISTS desktop_search_outcomes (
 identity TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
 fingerprint TEXT NOT NULL, outcome TEXT);`

export function desktopAuxiliaryMasterKey() {
    const value = process.env.RERUN_DESKTOP_SECRET_KEY ?? ''
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Credential storage is unavailable')
    return Buffer.from(value, 'hex')
}

export function desktopAuxiliaryStore(db: Client, key = desktopAuxiliaryMasterKey) {
    const aad = (purpose: string, revision: string) => Buffer.from(JSON.stringify(['desktop-auxiliary-v1', purpose, revision]))
    async function row(purpose: DesktopAuxiliaryPurpose) {
        return (await db.execute({ sql: 'SELECT revision,ciphertext FROM desktop_auxiliary_credentials WHERE purpose=?', args: [purpose] })).rows[0]
    }
    return {
        async list(): Promise<DesktopAuxiliaryStatus[]> {
            const rows = await db.execute('SELECT purpose,revision,ciphertext IS NOT NULL AS configured FROM desktop_auxiliary_credentials')
            return desktopAuxiliaryPurposes.map(purpose => {
                const saved = rows.rows.find(value => value.purpose === purpose)
                return { purpose, revision: saved ? String(saved.revision) : 'unconfigured', configured: !!saved?.configured }
            })
        },
        async read(purpose: DesktopAuxiliaryPurpose) {
            const saved = await row(purpose)
            if (!saved?.ciphertext) return { revision: saved ? String(saved.revision) : 'unconfigured', key: null }
            const revision = String(saved.revision), bytes = Buffer.from(String(saved.ciphertext), 'base64')
            if (bytes.length < 29) throw new Error('Credential is unavailable')
            const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12))
            decipher.setAAD(aad(purpose, revision)); decipher.setAuthTag(bytes.subarray(12, 28))
            const secret = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
            try { return { revision, key: secret.toString('utf8') } } finally { secret.fill(0) }
        },
        async change(input: unknown) {
            const change = desktopAuxiliaryChangeSchema.parse(input), revision = randomUUID()
            let encrypted: string | null = null
            if (change.key) {
                const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv)
                cipher.setAAD(aad(change.purpose, revision))
                const body = Buffer.concat([cipher.update(change.key, 'utf8'), cipher.final()])
                encrypted = Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
            }
            const result = change.expectedRevision === 'unconfigured'
                ? await db.execute({ sql: 'INSERT INTO desktop_auxiliary_credentials(purpose,revision,ciphertext) VALUES(?,?,?) ON CONFLICT DO NOTHING', args: [change.purpose, revision, encrypted] })
                : await db.execute({ sql: 'UPDATE desktop_auxiliary_credentials SET revision=?,ciphertext=? WHERE purpose=? AND revision=?', args: [revision, encrypted, change.purpose, change.expectedRevision] })
            if (result.rowsAffected !== 1) throw new Error('Settings changed; reload before saving')
        },
    }
}

