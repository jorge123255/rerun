import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { EXTERNAL_MCP_KEY_PREFIX, EXTERNAL_MCP_PREFIX_LENGTH, externalMcpCanonicalJson } from '@rerun/contracts'

const KEY_BYTES = 30

export function generateExternalMcpSecret(): string {
    return EXTERNAL_MCP_KEY_PREFIX + randomBytes(KEY_BYTES).toString('base64url')
}

export function hashExternalMcpSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex')
}

export function externalMcpKeyPrefix(secret: string): string {
    return secret.slice(0, EXTERNAL_MCP_PREFIX_LENGTH)
}

export function externalMcpFingerprint(value: unknown): string {
    return createHash('sha256').update(externalMcpCanonicalJson(value)).digest('hex')
}

/** Equal secrets, including the engine credential. Length is checked before the compare. */
export function sameExternalMcpSecret(actual: string, expected: string): boolean {
    const left = Buffer.from(actual)
    const right = Buffer.from(expected)
    return left.length === right.length && timingSafeEqual(left, right)
}

/** Mint a secret that is not the engine key. The engine key is never stored or returned here. */
export function mintExternalMcpSecret(engineKey: string | undefined): string {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const secret = generateExternalMcpSecret()
        if (!engineKey || !sameExternalMcpSecret(secret, engineKey)) return secret
    }
    throw new Error('Could not mint an external key.')
}
