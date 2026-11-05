import { createHash } from 'node:crypto'
import { desktopSemanticBackendCanonical, type DesktopSemanticBackendIdentity } from '@rerun/contracts'

const LOCAL_ID = /^[A-Za-z0-9_-]{1,128}$/

export function desktopSemanticLocalId(value: string): boolean {
    return LOCAL_ID.test(value)
}

export function desktopSemanticContentFingerprint(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function desktopSemanticBackendFingerprint(identity: DesktopSemanticBackendIdentity): string {
    return createHash('sha256').update(desktopSemanticBackendCanonical(identity), 'utf8').digest('hex')
}
