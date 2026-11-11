import 'server-only'
import type { Client } from '@libsql/client'
import { remoteMcpSchema, remoteMcpOAuthSchema, remoteMcpDeviceClientSchema } from './store'
import { remoteMcpOAuthAttemptSchema } from './oauth-attempt'

/** Additive, idempotent startup migration; desktop_agents must already exist. */
export async function initializeDesktopMcp(db: Client): Promise<void> {
    await db.executeMultiple(remoteMcpSchema + remoteMcpOAuthSchema + remoteMcpOAuthAttemptSchema + remoteMcpDeviceClientSchema)
}
