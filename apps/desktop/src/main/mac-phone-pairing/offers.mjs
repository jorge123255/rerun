import { randomUUID } from 'node:crypto'
import { hashSecret, randomSecret, secretMatches } from './crypto.mjs'
import { DEFAULT_OFFER_TTL_MS, MAX_OFFER_TTL_MS, PROTOCOL_VERSION, SERVICE_NAME } from './protocol.mjs'

export function createOfferBook({ now = Date.now, ttlMs = DEFAULT_OFFER_TTL_MS } = {}) {
    const offers = new Map()
    const lifetime = Math.min(Math.max(1, ttlMs), MAX_OFFER_TTL_MS)

    function prune(at) {
        for (const [id, offer] of offers) {
            if (offer.used || offer.expiresAt <= at) offers.delete(id)
        }
    }

    return {
        issue({ workspaceId, macId, fingerprint, origin }) {
            const at = now()
            prune(at)
            const secret = randomSecret()
            const offer = {
                offerId: randomUUID(),
                workspaceId,
                macId,
                fingerprint,
                secretHash: hashSecret(secret),
                expiresAt: at + lifetime,
                used: false,
                origin,
            }
            offers.set(offer.offerId, offer)
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
            }
        },

        // Every presented secret is hashed and compared in constant time. A miss,
        // an expiry, or a second use all collapse to the same invalid_offer result.
        redeem({ offerId, macId, fingerprint, secret }) {
            const at = now()
            prune(at)
            const offer = typeof offerId === 'string' ? offers.get(offerId) : null
            const dummy = offer ?? { secretHash: '0'.repeat(64), used: true, expiresAt: 0, macId: '', fingerprint: '', workspaceId: 0, offerId: '' }
            const matches = secretMatches(secret, dummy.secretHash)
            const identity = dummy.macId === macId && dummy.fingerprint === fingerprint
            if (!offer || offer.used || offer.expiresAt <= at || !matches || !identity) return null
            offer.used = true
            offers.delete(offer.offerId)
            return { offerId: offer.offerId, workspaceId: offer.workspaceId, macId: offer.macId, fingerprint: offer.fingerprint, origin: offer.origin }
        },

        size() {
            prune(now())
            return offers.size
        },
        clear() { offers.clear() },
    }
}
