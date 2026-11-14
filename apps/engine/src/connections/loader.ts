import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { CONNECTION_TOKEN_KEY, RERUN_CONNECTION_ID, connectionConfigSchema, isDesktopSubscriptionProvider, type ConnectionSummary } from '@rerun/contracts'
import { connectionConfigPath, connectionEnvPath, connectionsDir } from '../config/paths.js'
import { readEnvFile } from '../lib/env-file.js'
import { env } from '../config/env.js'
import { isCredentialRejected } from './credential-rejections.js'
import { DESKTOP_CODEX_ID, signedInFlag } from '../desktop/codex-runtime.js'
import { desktopApp } from '../desktop/policy.js'
import { readPlanLimits } from './plan-limits.js'
import type { LoadedConnection } from './types.js'
import { findDesktopSubscriptionConnection } from '../desktop/subscription-acp/connections.js'

export function connectionExists(id: string): boolean {
    return existsSync(connectionConfigPath(id))
}

export async function loadConnectionFromDisk(id: string): Promise<LoadedConnection> {
    const config = connectionConfigSchema.parse(JSON.parse(await readFile(connectionConfigPath(id), 'utf8')))
    if (config.provider === 'custom' || config.provider === 'opencode') throw new Error('Custom connections require registered desktop custody.')
    if (isDesktopSubscriptionProvider(config.provider)) throw new Error('Subscription connections require desktop sign-in.')
    const connEnv = await readEnvFile(connectionEnvPath(id))
    return { id, config, env: connEnv }
}

export async function listConnectionIds(): Promise<string[]> {
    const root = connectionsDir()
    if (!existsSync(root)) return []
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter(e => e.isDirectory() && connectionExists(e.name)).map(e => e.name)
}

// The keyless `rerun` connection is served by the hub, which holds the shared key: it counts as
// connected when the box knows where to reach the hub and how to authenticate against it.
export function isConnected(connection: LoadedConnection): boolean {
    if (isDesktopSubscriptionProvider(connection.config.provider)) return findDesktopSubscriptionConnection(connection.id) !== null
    if (connection.config.provider === 'opencode') return desktopApp() && !!connection.opencode
    if (connection.config.provider === 'custom') return desktopApp() && connection.custom?.state === 'configured'
    if (desktopApp() && connection.config.provider === 'codex') return connection.id === DESKTOP_CODEX_ID && connection.env[signedInFlag] === '1'
    if (connection.id === RERUN_CONNECTION_ID) {
        const { RERUN_HUB_BASE_URL, RERUN_API_KEY } = env()
        return !!RERUN_HUB_BASE_URL && !!RERUN_API_KEY
    }
    const key = CONNECTION_TOKEN_KEY[connection.config.provider]
    return !!key && !!connection.env[key]
}

export function toSummary(connection: LoadedConnection): ConnectionSummary {
    return { id: connection.id, ...connection.config, connected: isConnected(connection), credentialRejected: isCredentialRejected(connection.id), planLimits: readPlanLimits(connection.id), ...(connection.custom && { customRevision: connection.custom.revision }) }
}
