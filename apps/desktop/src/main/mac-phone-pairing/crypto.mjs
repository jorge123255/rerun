import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { FINGERPRINT_PREFIX, HASH_PREFIX } from './protocol.mjs'

export function randomSecret() {
    return randomBytes(32).toString('base64url')
}

export function hashSecret(secret) {
    if (typeof secret !== 'string' || !secret) return null
    return createHash('sha256').update(HASH_PREFIX).update(secret).digest('hex')
}

export function macFingerprint(installId) {
    return createHash('sha256').update(FINGERPRINT_PREFIX).update(String(installId)).digest('hex')
}

function hexBuffer(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return null
    return Buffer.from(value, 'hex')
}

// Length is checked first so timingSafeEqual is only called on equal-length digests.
export function hashesEqual(left, right) {
    const a = hexBuffer(left)
    const b = hexBuffer(right)
    if (!a || !b) return false
    return timingSafeEqual(a, b)
}

export function secretMatches(secret, expectedHash) {
    return hashesEqual(hashSecret(secret), expectedHash)
}
