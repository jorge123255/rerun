import 'server-only'
import type { Client } from '@libsql/client'

// Chief owns a managed turn, not a desktop_agents row. Its tool-call receipts follow that turn.
export async function initializeDesktopRound75(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 75, id = 'foreman-shared-vault-calls'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.execute(`CREATE TABLE desktop_foreman_service_calls(
                run_id TEXT NOT NULL REFERENCES desktop_foreman_turns(request_id) ON DELETE CASCADE,
                call_id TEXT NOT NULL, PRIMARY KEY(run_id,call_id))`)
            await tx.execute({sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version,id]})
        }
        await tx.commit()
    } finally { tx.close() }
}
