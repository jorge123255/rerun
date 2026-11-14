import 'server-only'
import type { Client } from '@libsql/client'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { assertDesktopWorkspaceAdmission } from './workspace-admission'
import type { DesktopProfile } from '../local-profile'

export function desktopProfileDatabase(runtime: DesktopRuntime) {
    return openDesktopDatabase(runtime.installRoot ?? runtime.dataRoot)
}

export async function readDesktopProfile(db: Client): Promise<DesktopProfile> {
    const row = (await db.execute(`SELECT p.display_name, photo.identity FROM desktop_profile p
        LEFT JOIN desktop_profile_photo photo ON p.id=photo.profile_id WHERE p.id=1`)).rows[0]
    if (!row) throw new DesktopHttpError(404, 'Local profile not found.')
    return { id: 1, displayName: String(row.display_name), photoId: typeof row.identity === 'string' ? row.identity : null }
}

export async function updateDesktopProfileName(runtime: DesktopRuntime, name: string, signal: AbortSignal) {
    const db = await desktopProfileDatabase(runtime)
    signal.throwIfAborted()
    assertDesktopWorkspaceAdmission(runtime)
    await db.execute({ sql: 'UPDATE desktop_profile SET display_name=?,updated_at=? WHERE id=1', args: [name, new Date().toISOString()] })
    return readDesktopProfile(db)
}

export async function updateDesktopProfilePhoto(runtime: DesktopRuntime, bytes: Uint8Array | null, signal: AbortSignal) {
    const db = await desktopProfileDatabase(runtime)
    signal.throwIfAborted()
    assertDesktopWorkspaceAdmission(runtime)
    if (bytes) {
        await db.execute({ sql: `INSERT INTO desktop_profile_photo(profile_id,identity,bytes) VALUES (1,?,?)
            ON CONFLICT(profile_id) DO UPDATE SET identity=excluded.identity,bytes=excluded.bytes`,
            args: [crypto.randomUUID(), bytes] })
    } else await db.execute('DELETE FROM desktop_profile_photo WHERE profile_id=1')
    return readDesktopProfile(db)
}

export async function readDesktopProfilePhoto(runtime: DesktopRuntime, identity: string) {
    const db = await desktopProfileDatabase(runtime)
    const stored = (await db.execute({
        sql: 'SELECT bytes FROM desktop_profile_photo WHERE profile_id=1 AND identity=?', args: [identity],
    })).rows[0]?.bytes
    if (stored instanceof Uint8Array) return Uint8Array.from(stored)
    if (stored instanceof ArrayBuffer) return new Uint8Array(stored)
    throw new DesktopHttpError(404, 'Local profile photo not found.')
}
