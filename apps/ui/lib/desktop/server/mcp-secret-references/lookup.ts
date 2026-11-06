import 'server-only'
import type { Client } from '@libsql/client'

export type DesktopMcpSecretGate = { check: () => void }

export type DesktopMcpSecretOpener = {
    useCredential<T>(agentId: string, key: string, authority: DesktopMcpSecretGate, use: (value: Uint8Array) => T | Promise<T>): Promise<T>
}

export type DesktopMcpSecretVersion =
    | { state: 'present'; version: number }
    | { state: 'missing' }
    | { state: 'forbidden' }

export type DesktopMcpSecretOpen<T> =
    | { state: 'present'; version: number; produced: T }
    | { state: 'missing' }
    | { state: 'rotated'; version: number }
    | { state: 'forbidden' }
    | { state: 'invalid' }

const MISSING = 'Credential not found for this coworker.'

function closed(gate: DesktopMcpSecretGate): boolean {
    try {
        gate.check()
        return false
    } catch {
        return true
    }
}

export function createDesktopMcpSecretLookup(db: Pick<Client, 'execute'>, opener: DesktopMcpSecretOpener) {
    return {
        async version(agentId: string, key: string, gate: DesktopMcpSecretGate): Promise<DesktopMcpSecretVersion> {
            if (closed(gate)) return { state: 'forbidden' }
            const row = (await db.execute({
                sql: 'SELECT version FROM desktop_secret_credentials WHERE agent_id = ? AND key = ?',
                args: [agentId, key],
            })).rows[0]
            if (!row) return { state: 'missing' }
            return { state: 'present', version: Number(row.version) }
        },

        async open<T>(agentId: string, key: string, expectedVersion: number, gate: DesktopMcpSecretGate, use: (value: Uint8Array) => Promise<T>): Promise<DesktopMcpSecretOpen<T>> {
            if (closed(gate)) return { state: 'forbidden' }
            if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return { state: 'invalid' }
            const row = (await db.execute({
                sql: 'SELECT version FROM desktop_secret_credentials WHERE agent_id = ? AND key = ?',
                args: [agentId, key],
            })).rows[0]
            if (!row) return { state: 'missing' }
            const version = Number(row.version)
            if (version !== expectedVersion) return { state: 'rotated', version }
            try {
                const produced = await opener.useCredential(agentId, key, gate, async value => use(value))
                return { state: 'present', version, produced }
            } catch (error) {
                if (error instanceof Error && error.name === 'DesktopMcpSecretReferenceFailure') throw error
                if (error instanceof Error && error.message === MISSING) return { state: 'missing' }
                return { state: 'forbidden' }
            }
        },
    }
}

export type DesktopMcpSecretLookup = ReturnType<typeof createDesktopMcpSecretLookup>
