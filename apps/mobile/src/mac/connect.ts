import { macPairingOfferSchema } from '@rerun/mac-contracts/mac-phone-pairing'

import { isLocalNetworkHost } from '@/config/server-connect'

import type { MacClient } from './client'

export type MacPairingProblem = 'invalid' | 'expired' | 'unreachable' | 'unsupported' | 'declined' | 'off'

export type MacOfferRead = { ok: true; offer: ReturnType<typeof macPairingOfferSchema.parse> } | { ok: false; problem: MacPairingProblem }

const POLL_MS = 1500

// The code the Mac shows, scanned or pasted: the JSON under its QR code, or a `rerun-mac://pair` link.
// The Mac's address has to be one of the person's own network, the rule the app already keeps for a
// server typed by hand: an offer naming any other host is refused before anything is sent to it.
export function readMacOffer(client: Pick<MacClient, 'parseOffer'>, input: string, now = Date.now()): MacOfferRead {
    let parsed: ReturnType<typeof macPairingOfferSchema.safeParse>
    try {
        parsed = macPairingOfferSchema.safeParse(client.parseOffer(input))
    } catch {
        return { ok: false, problem: 'invalid' }
    }
    if (!parsed.success) return { ok: false, problem: 'invalid' }
    const offer = parsed.data
    let address: URL
    try {
        address = new URL(offer.origin)
    } catch {
        return { ok: false, problem: 'invalid' }
    }
    if (!isLocalNetworkHost(address.hostname)) return { ok: false, problem: 'invalid' }
    if (address.protocol === 'https:' ? !offer.certificateFingerprint : address.hostname !== '127.0.0.1') return { ok: false, problem: 'invalid' }
    const expiresAt = Date.parse(offer.expiresAt)
    if (Number.isFinite(expiresAt) && expiresAt <= now) return { ok: false, problem: 'expired' }
    return { ok: true, offer }
}

export function pairingProblemOf(error: unknown): MacPairingProblem {
    const { status, message } = error as { status?: number; message?: string }
    if (message === 'pinned_transport_required') return 'unsupported'
    if (message === 'invalid_offer' && status === undefined) return 'invalid'
    if (status === 401) return 'expired'
    if (status === 403) return 'off'
    return 'unreachable'
}

const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>(resolve => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })

// Hands the code to the Mac, then waits for the person to approve the phone there. Resolves once the
// phone holds its token; the app then starts again on the Mac. `onWaiting` fires when the Mac has
// listed the phone and the rest is up to the person.
export async function pairWithMac(client: Pick<MacClient, 'connectToThisMac' | 'waitForApproval' | 'clearMacSession'>, offer: MacOfferRead & { ok: true }, { signal, onWaiting, pollMs = POLL_MS }: { signal: AbortSignal; onWaiting: () => void; pollMs?: number }): Promise<{ ok: true } | { ok: false; problem: MacPairingProblem | 'cancelled' }> {
    try {
        await client.connectToThisMac(offer.offer, signal)
    } catch (error) {
        return { ok: false, problem: signal.aborted ? 'cancelled' : pairingProblemOf(error) }
    }
    onWaiting()
    let misses = 0
    while (!signal.aborted) {
        try {
            const { status } = await client.waitForApproval(signal)
            if (status === 'approved') return { ok: true }
            if (status === 'revoked') {
                await client.clearMacSession()
                return { ok: false, problem: 'declined' }
            }
            misses = 0
        } catch (error) {
            // One lost answer is a blip on the network; a refusal, or several misses in a row, is not.
            if (signal.aborted) break
            const refused = typeof (error as { status?: number }).status === 'number'
            if (refused || ++misses >= 5) {
                await client.clearMacSession()
                return { ok: false, problem: refused ? 'declined' : 'unreachable' }
            }
        }
        await pause(pollMs, signal)
    }
    // Left before the approval: the request is forgotten here and runs out on the Mac.
    await client.clearMacSession()
    return { ok: false, problem: 'cancelled' }
}
