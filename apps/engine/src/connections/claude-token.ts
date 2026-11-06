import { connectionEnvPath } from '../config/paths.js'
import { readEnvFile, writeEnvFile } from '../lib/env-file.js'
import { logger } from '../lib/logger.js'
import { forgetCredentialRejected, isCredentialRejected, recordCredentialRejected } from './credential-rejections.js'
import { withConnectionLock } from './lock.js'
import type { LoadedConnection } from './types.js'

const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const REFRESH_SKEW_MS = 5 * 60_000
// Anthropic revokes the old access token the moment it hands out a new one, and a running CLI holds
// the token it was spawned with. So a refresh happens while no CLI is out on this connection, hours
// before the token runs out, and only the last minutes force one under a live run.
const IDLE_REFRESH_WINDOW_MS = 4 * 3_600_000
const IDLE_RETRY_BACKOFF_MS = 10 * 60_000
const NETWORK_RETRY_DELAYS_MS = [1_000, 4_000]

const TOKEN_KEY = 'CLAUDE_CODE_OAUTH_TOKEN'
const REFRESH_KEY = 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN'
const EXPIRES_KEY = 'CLAUDE_CODE_OAUTH_EXPIRES_AT'

const inFlight = new Map<string, Promise<void>>()
const leases = new Map<string, number>()
const lastFailedAt = new Map<string, number>()

function isTransient(status: number): boolean {
    return status === 429 || status >= 500
}

async function postRefresh(refreshToken: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
        const delay = NETWORK_RETRY_DELAYS_MS[attempt]
        try {
            const res = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ grant_type: 'refresh_token', client_id: CLAUDE_OAUTH_CLIENT_ID, refresh_token: refreshToken }),
            })
            if (delay === undefined || !isTransient(res.status)) return res
        } catch (err) {
            if (delay === undefined) throw err
        }
        await new Promise(resolve => setTimeout(resolve, delay))
    }
}

async function refresh(connection: LoadedConnection, refreshToken: string): Promise<void> {
    const priorToken = connection.env[TOKEN_KEY]
    const res = await postRefresh(refreshToken)
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: unknown; error_description?: unknown }
    if (!res.ok || !data.access_token) {
        // A 400/401 is a refresh token Anthropic no longer honours: every run on this connection now
        // fails with "OAuth access token has expired" until the user signs in again.
        const dead = res.status === 400 || res.status === 401
        logger[dead ? 'error' : 'warn']({ connection: connection.id, status: res.status, hasAccessToken: !!data.access_token }, 'claude token refresh failed')
        await withConnectionLock(connection.id, async () => {
            const current = await readEnvFile(connectionEnvPath(connection.id))
            if (current[TOKEN_KEY] !== priorToken || current[REFRESH_KEY] !== refreshToken) return
            if (dead) recordCredentialRejected(connection.id)
            lastFailedAt.set(connection.id, Date.now())
        })
        return
    }
    logger.info({ connection: connection.id, hasNewRefreshToken: !!data.refresh_token, expiresIn: data.expires_in ?? null }, 'claude token refresh response ok')

    const nextToken = data.access_token
    const nextRefresh = data.refresh_token ?? refreshToken
    const expiresAt = typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : undefined

    const applied = await withConnectionLock(connection.id, async () => {
        const path = connectionEnvPath(connection.id)
        const env = await readEnvFile(path)
        if (env[TOKEN_KEY] !== priorToken || env[REFRESH_KEY] !== refreshToken) return false
        env[TOKEN_KEY] = nextToken
        env[REFRESH_KEY] = nextRefresh
        if (expiresAt !== undefined) env[EXPIRES_KEY] = String(expiresAt)
        else delete env[EXPIRES_KEY]
        await writeEnvFile(path, env)

        // The connection object is shared by every agent drawing on it, so mutating it in place is
        // what makes the fresh token visible box-wide without a reload.
        connection.env[TOKEN_KEY] = nextToken
        connection.env[REFRESH_KEY] = nextRefresh
        if (expiresAt !== undefined) connection.env[EXPIRES_KEY] = String(expiresAt)
        else delete connection.env[EXPIRES_KEY]
        return true
    })
    if (!applied) return

    forgetCredentialRejected(connection.id)
    lastFailedAt.delete(connection.id)
    logger.info({ connection: connection.id, expiresAt }, 'claude token refreshed')
}

export async function ensureFreshClaudeToken(connection: LoadedConnection | null): Promise<void> {
    if (!connection) return
    const pending = inFlight.get(connection.id)
    if (pending) return pending

    const refreshToken = connection.env[REFRESH_KEY]
    const expiresAtRaw = connection.env[EXPIRES_KEY]
    if (!refreshToken || !expiresAtRaw) {
        logger.debug({ connection: connection.id, hasRefreshToken: !!refreshToken, hasExpiresAt: !!expiresAtRaw }, 'claude token: static, skipping refresh')
        return
    }

    const expiresAt = Number(expiresAtRaw)
    const msLeft = expiresAt - Date.now()
    if (!Number.isFinite(expiresAt) || msLeft > IDLE_REFRESH_WINDOW_MS) {
        logger.debug({ connection: connection.id, minutesLeft: Math.round(msLeft / 60_000) }, 'claude token: still valid')
        return
    }
    if (msLeft > REFRESH_SKEW_MS) {
        const leased = leases.get(connection.id) ?? 0
        const failedAt = lastFailedAt.get(connection.id)
        const backingOff = failedAt !== undefined && Date.now() - failedAt < IDLE_RETRY_BACKOFF_MS
        if (leased > 0 || backingOff) {
            logger.debug({ connection: connection.id, minutesLeft: Math.round(msLeft / 60_000), leased, backingOff }, 'claude token: refresh deferred')
            return
        }
    }

    logger.info({ connection: connection.id, minutesLeft: Math.round(msLeft / 60_000) }, 'claude token: refreshing')

    const task = refresh(connection, refreshToken)
        .catch(() => {
            lastFailedAt.set(connection.id, Date.now())
            logger.warn({ connection: connection.id }, 'claude token refresh skipped')
        })
        .finally(() => inFlight.delete(connection.id))
    inFlight.set(connection.id, task)
    return task
}

export function claudeTokenOf(connection: LoadedConnection | null): string | undefined {
    return connection?.env[TOKEN_KEY]
}

// Whether the token a CLI was spawned with has since been swapped for a new one or run out. Either
// way a 401 from that CLI says nothing about the connection itself. A lapse the engine could not
// make up for because the refresh token is dead is the one exception: that 401 is a real sign-out.
export function claudeTokenOutlived(connection: LoadedConnection | null, spawnToken: string | undefined): boolean {
    if (!connection || !spawnToken) return false
    if (connection.env[TOKEN_KEY] !== spawnToken) return true
    const expiresAt = Number(connection.env[EXPIRES_KEY])
    return Number.isFinite(expiresAt) && expiresAt <= Date.now() && !isCredentialRejected(connection.id)
}

// Held for as long as a CLI spawned on this connection may still be calling Anthropic with the
// token it was given. Giving back the last one is the idle moment a refresh waits for.
export function acquireClaudeLease(connection: LoadedConnection | null): () => void {
    if (!connection) return () => {}
    leases.set(connection.id, (leases.get(connection.id) ?? 0) + 1)
    let released = false
    return () => {
        if (released) return
        released = true
        const left = (leases.get(connection.id) ?? 1) - 1
        if (left > 0) {
            leases.set(connection.id, left)
            return
        }
        leases.delete(connection.id)
        void ensureFreshClaudeToken(connection)
    }
}
