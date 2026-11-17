import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { DesktopVoiceRelayDeploy } from '../../voice-engine'
import { desktopAuxiliaryMasterKey } from '../auxiliary/store'

// One row: the relay this Mac uses, its per-install id and secret (encrypted with the same master key
// as the Tool services keys), the engine made for it, and the switch. Off until the owner turns it on.
export const desktopVoiceEngineSchema = `CREATE TABLE IF NOT EXISTS desktop_voice_engine (
 id INTEGER PRIMARY KEY CHECK(id = 1),
 relay_origin TEXT, install_id TEXT, secret_revision TEXT, secret_ciphertext TEXT,
 engine_id TEXT, engine_key_revision TEXT, engine_relay TEXT,
 enabled INTEGER NOT NULL DEFAULT 0)`

export type VoiceEngineSettings = {
    relayOrigin: string | null
    installId: string | null
    hasSecret: boolean
    engineId: string | null
    /** The ElevenLabs key revision and relay address the engine was made with. */
    engineKeyRevision: string | null
    engineRelay: string | null
    enabled: boolean
}

const text = (value: unknown) => typeof value === 'string' && value ? value : null

export function desktopVoiceEngineStore(db: Client, key = desktopAuxiliaryMasterKey) {
    const aad = (revision: string) => Buffer.from(JSON.stringify(['desktop-voice-relay-v1', revision]))
    let ready: Promise<unknown> | undefined
    const init = () => (ready ??= db.execute(desktopVoiceEngineSchema).then(() => db.execute('INSERT INTO desktop_voice_engine(id) VALUES(1) ON CONFLICT(id) DO NOTHING')))

    function encrypt(secret: string, revision: string) {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv)
        cipher.setAAD(aad(revision))
        const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
        return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
    }

    async function credentials(): Promise<DesktopVoiceRelayDeploy> {
        const installId = randomBytes(32).toString('base64url'), relaySecret = randomBytes(32).toString('base64url'), revision = randomUUID()
        await db.execute({
            sql: 'UPDATE desktop_voice_engine SET install_id=?, secret_revision=?, secret_ciphertext=?, engine_id=NULL, engine_key_revision=NULL, engine_relay=NULL, enabled=0 WHERE id=1',
            args: [installId, revision, encrypt(relaySecret, revision)],
        })
        return { installId, relaySecret, workerSecret: JSON.stringify({ [installId]: relaySecret }) }
    }

    async function read(): Promise<VoiceEngineSettings> {
        await init()
        const row = (await db.execute('SELECT relay_origin, install_id, secret_ciphertext IS NOT NULL AS has_secret, engine_id, engine_key_revision, engine_relay, enabled FROM desktop_voice_engine WHERE id=1')).rows[0]
        return {
            relayOrigin: text(row?.relay_origin), installId: text(row?.install_id), hasSecret: !!row?.has_secret,
            engineId: text(row?.engine_id), engineKeyRevision: text(row?.engine_key_revision), engineRelay: text(row?.engine_relay),
            enabled: Number(row?.enabled ?? 0) === 1,
        }
    }

    return {
        read,
        /** The relay secret, for signing the next connection only. */
        async secret(): Promise<string | null> {
            await init()
            const row = (await db.execute('SELECT secret_revision, secret_ciphertext FROM desktop_voice_engine WHERE id=1')).rows[0]
            if (!row?.secret_ciphertext || !row.secret_revision) return null
            const bytes = Buffer.from(String(row.secret_ciphertext), 'base64')
            if (bytes.length < 29) return null
            const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12))
            decipher.setAAD(aad(String(row.secret_revision)))
            decipher.setAuthTag(bytes.subarray(12, 28))
            const secret = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
            try { return secret.toString('utf8') } finally { secret.fill(0) }
        },
        /** Saves the relay address. The first time, makes this Mac's id and secret and returns them, once. */
        async saveRelay(origin: string): Promise<DesktopVoiceRelayDeploy | null> {
            await init()
            const current = await read()
            await db.execute({ sql: 'UPDATE desktop_voice_engine SET relay_origin=? WHERE id=1', args: [origin] })
            if (current.installId && current.hasSecret) {
                // A new address needs a new engine; the old one points ElevenLabs at the old relay.
                if (current.relayOrigin !== origin) await db.execute('UPDATE desktop_voice_engine SET enabled=0 WHERE id=1')
                return null
            }
            return credentials()
        },
        /** A new id and secret, shown once. The engine has to be made again, for the new address. */
        async rotate(): Promise<DesktopVoiceRelayDeploy> {
            await init()
            return credentials()
        },
        async setEngine(engineId: string, keyRevision: string, relay: string) {
            await init()
            await db.execute({ sql: 'UPDATE desktop_voice_engine SET engine_id=?, engine_key_revision=?, engine_relay=? WHERE id=1', args: [engineId, keyRevision, relay] })
        },
        async setEnabled(enabled: boolean) {
            await init()
            await db.execute({ sql: 'UPDATE desktop_voice_engine SET enabled=? WHERE id=1', args: [enabled ? 1 : 0] })
        },
        async forget() {
            await init()
            await db.execute('UPDATE desktop_voice_engine SET relay_origin=NULL, install_id=NULL, secret_revision=NULL, secret_ciphertext=NULL, engine_id=NULL, engine_key_revision=NULL, engine_relay=NULL, enabled=0 WHERE id=1')
        },
    }
}
export type DesktopVoiceEngineStore = ReturnType<typeof desktopVoiceEngineStore>
