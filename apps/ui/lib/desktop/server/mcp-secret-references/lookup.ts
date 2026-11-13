import 'server-only'
import type { Client } from '@libsql/client'
import type { DesktopSecretCredentialAuthority } from '../secret-requests/store'

export type DesktopMcpSecretGate = { check: (credential?: { agentId: string; key: string; version?: number }) => void | Promise<void> }
export type DesktopMcpSecretOpener = {
    useCredential<T>(agentId: string, key: string, authority: DesktopSecretCredentialAuthority, invoke: (value: Uint8Array) => T | Promise<T>): Promise<T>
}
export type DesktopMcpSecretVersion = { state: 'present'; version: number } | { state: 'missing' } | { state: 'forbidden' }
export type DesktopMcpSecretOpen<T> = { state: 'present'; version: number; produced: T } | { state: 'missing' } | { state: 'rotated'; version: number } | { state: 'forbidden' } | { state: 'invalid' }
const MISSING = 'Credential not found for this coworker.'

export function createDesktopMcpSecretLookup(db: Pick<Client, 'execute'>, opener: DesktopMcpSecretOpener, readVersion = async (agentId: string, key: string) => {
    const row = (await db.execute({ sql: 'SELECT version FROM desktop_secret_credentials WHERE agent_id = ? AND key = ?', args: [agentId, key] })).rows[0]
    return row ? Number(row.version) : undefined
}) {
    return {
        async version(agentId: string, key: string, gate: DesktopMcpSecretGate): Promise<DesktopMcpSecretVersion> {
            try {
                await gate.check({ agentId, key })
                const version = await readVersion(agentId, key)
                await gate.check({ agentId, key })
                return version === undefined ? { state: 'missing' } : { state: 'present', version }
            } catch { return { state: 'forbidden' } }
        },
        async open<T>(agentId: string, key: string, expectedVersion: number, gate: DesktopMcpSecretGate, invoke: (value: Uint8Array) => Promise<T>): Promise<DesktopMcpSecretOpen<T>> {
            if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return { state: 'invalid' }
            let rotated: number | undefined
            const exact: DesktopSecretCredentialAuthority = { async check(credential) {
                if (credential.agentId !== agentId || credential.key !== key) throw new Error('Credential owner changed')
                if (credential.version !== undefined && credential.version !== expectedVersion) { rotated = credential.version; throw new Error('Credential version changed') }
                await gate.check(credential)
            } }
            try {
                await exact.check({ agentId, key })
                const produced = await opener.useCredential(agentId, key, exact, async value => {
                    await exact.check({ agentId, key, version: expectedVersion })
                    const result = await invoke(value)
                    await exact.check({ agentId, key, version: expectedVersion })
                    return result
                })
                return { state: 'present', version: expectedVersion, produced }
            } catch (error) {
                if (rotated !== undefined) return { state: 'rotated', version: rotated }
                if (error instanceof Error && error.name === 'DesktopMcpSecretReferenceFailure') throw error
                if (error instanceof Error && error.message === MISSING) return { state: 'missing' }
                return { state: 'forbidden' }
            }
        },
    }
}
export type DesktopMcpSecretLookup = ReturnType<typeof createDesktopMcpSecretLookup>
