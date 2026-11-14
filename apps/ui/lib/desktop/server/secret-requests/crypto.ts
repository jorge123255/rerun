import 'server-only'
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

export type DesktopSecretEncryptionContext = {
    domain: 'credential' | 'staging' | 'vault'
    agentId: string
    key: string
    version: number
    requestId?: string
    attemptId?: string
    workspaceId?: number
    revision?: string
}

export type DesktopSecretCrypto = {
    seal: (context: DesktopSecretEncryptionContext, value: Uint8Array) => Promise<string>
    open: (context: DesktopSecretEncryptionContext, sealed: string) => Promise<Uint8Array>
    fingerprint: (context: { agentId: string; requestId: string; attemptId: string }, value: Uint8Array) => Promise<string>
}

export function createDesktopSecretCrypto(keyReader: () => Buffer): DesktopSecretCrypto {
    const key = () => {
        const value = keyReader()
        if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error('Desktop secret encryption is unavailable.')
        return value
    }
    const aad = (context: DesktopSecretEncryptionContext) => Buffer.from(JSON.stringify(context.domain === 'vault'
        ? ['desktop-vault-v1', context.workspaceId, context.agentId, context.key, context.revision]
        : ['desktop-secret-request-v1', context]))
    return {
        async seal(context, value) {
            const iv = randomBytes(12)
            const cipher = createCipheriv('aes-256-gcm', key(), iv)
            cipher.setAAD(aad(context))
            const body = Buffer.concat([cipher.update(value), cipher.final()])
            return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
        },
        async open(context, sealed) {
            const bytes = Buffer.from(sealed, 'base64')
            if (bytes.length < 29) throw new Error('Encrypted credential is damaged.')
            const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12))
            decipher.setAAD(aad(context))
            decipher.setAuthTag(bytes.subarray(12, 28))
            return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
        },
        async fingerprint(context, value) {
            return createHmac('sha256', key()).update(JSON.stringify(['desktop-secret-attempt-v1', context])).update(value).digest('hex')
        },
    }
}
