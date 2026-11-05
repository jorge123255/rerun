import type { Client } from '@libsql/client'

// Permanent coworker deletion removes receipts: its trusted owner can no longer authorize a run.
// Disable/enable, service restarts and lost acknowledgements preserve exact-call receipts.
export const privateFileReceiptSchema = `CREATE TABLE IF NOT EXISTS desktop_private_file_calls (
    owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL, call_id TEXT NOT NULL, digest TEXT NOT NULL,
    state TEXT NOT NULL, result TEXT, PRIMARY KEY(owner, run_id, call_id));`

export async function ensureDesktopPrivateFileToolsSchema(db: Client): Promise<void> {
    await db.executeMultiple(privateFileReceiptSchema)
}
