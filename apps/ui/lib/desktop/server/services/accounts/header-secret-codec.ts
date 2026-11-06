import 'server-only'

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { DESKTOP_SERVICE_ACCOUNT_MESSAGES as M } from '@rerun/contracts'

const AAD_LABEL = 'desktop-service-header-v1'

export type HeaderSecretBundle = {
    headers: Record<string, string>
    inputs: Record<string, string>
}

function aad(owner: string, installationId: string, revision: string): Buffer {
    return Buffer.from(JSON.stringify([AAD_LABEL, owner, installationId, revision]))
}

function stringRecord(value: unknown, label: string): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(M.secretConflict)
    const record = value as Record<string, unknown>
    if (label === 'root' && Object.keys(record).some(key => key !== 'headers' && key !== 'inputs')) throw new Error(M.secretConflict)
    const out: Record<string, string> = {}
    for (const [key, item] of Object.entries(record)) {
        if (typeof item !== 'string') throw new Error(M.secretConflict)
        out[key] = item
    }
    return out
}

/** Same AES-256-GCM layout as the service bearer column. Revision is part of the AAD. */
export function sealHeaderBundle(key: Buffer, owner: string, installationId: string, revision: string, bundle: HeaderSecretBundle): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aad(owner, installationId, revision))
    const bytes = Buffer.concat([cipher.update(JSON.stringify({ headers: bundle.headers, inputs: bundle.inputs }), 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64')
}

/** Opens a stored bundle. Crypto failures become the allowlisted conflict and do not include the ciphertext. */
export function openStoredHeaderBundle(key: Buffer, owner: string, installationId: string, revision: string, sealed: string): HeaderSecretBundle {
    try {
        return openHeaderBundle(key, owner, installationId, revision, sealed)
    } catch (error) {
        if (error instanceof Error && error.message === M.secretConflict) throw error
        throw new Error(M.secretConflict)
    }
}

export function openHeaderBundle(key: Buffer, owner: string, installationId: string, revision: string, sealed: string): HeaderSecretBundle {
    const bytes = Buffer.from(sealed, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
    decipher.setAAD(aad(owner, installationId, revision))
    decipher.setAuthTag(bytes.subarray(12, 28))
    const parsed: unknown = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(M.secretConflict)
    const record = parsed as Record<string, unknown>
    return { headers: stringRecord(record.headers, 'headers'), inputs: stringRecord(record.inputs, 'inputs') }
}

export function bundlesMatch(left: HeaderSecretBundle, right: HeaderSecretBundle): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
}
