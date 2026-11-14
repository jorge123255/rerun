import { randomUUID } from 'node:crypto'
import { hashSecret, randomSecret, secretMatches } from './crypto.mjs'
import { DEFAULT_OFFER_TTL_MS, MAX_OFFER_TTL_MS, PROTOCOL_VERSION, SERVICE_NAME } from './protocol.mjs'

export function createOfferBook({ now = Date.now, ttlMs = DEFAULT_OFFER_TTL_MS } = {}) {
    let current = null
    const lifetime = Math.min(Math.max(1, ttlMs), MAX_OFFER_TTL_MS)

    function active(at) {
        if (current && current.expiresAt <= at) current = null
        return current
    }

    return {
        issue({ workspaceId, macId, fingerprint, origin, certificateFingerprint, runtime }) {
            const at = now()
            const secret = randomSecret()
            const offer = {
                offerId: randomUUID(),
                workspaceId,
                macId,
                fingerprint,
                secretHash: hashSecret(secret),
                expiresAt: at + lifetime,
                runtime,
                origin,
            }
            current = offer
            return {
                version: PROTOCOL_VERSION,
                kind: SERVICE_NAME,
                offerId: offer.offerId,
                workspaceId,
                macId,
                fingerprint,
                secret,
                expiresAt: new Date(offer.expiresAt).toISOString(),
                origin,
                ttlMs: lifetime,
                ...(certificateFingerprint ? { certificateFingerprint } : {}),
            }
        },

        // Every presented secret is hashed and compared in constant time. A miss,
        // an expiry, or a second use all collapse to the same invalid_offer result.
        redeem({ offerId, macId, fingerprint, secret }, runtime) {
            const offer = active(now())
            const matches = secretMatches(secret, offer?.secretHash ?? '0'.repeat(64))
            if (!offer || offer.offerId !== offerId || offer.runtime !== runtime
                || offer.macId !== macId || offer.fingerprint !== fingerprint || !matches) return null
            current = null
            return { workspaceId: offer.workspaceId, origin: offer.origin }
        },

        activeId(runtime) {
            const offer = active(now())
            return offer && offer.runtime === runtime ? offer.offerId : null
        },
        clear() { current = null },
    }
}
