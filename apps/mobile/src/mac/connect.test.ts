import { createMacPairingClient } from '@rerun/mac-pairing-client'

import { pairingProblemOf, pairWithMac, readMacOffer } from './connect'
import { parseMacLink } from './session'

const PIN = 'a'.repeat(64)
const OFFER = { version: 1, kind: 'rerun-mac-phone-pairing', offerId: '0b0f2c4e-6a1d-4f8b-9c3e-5d7a9b1c3e5f', workspaceId: 1, macId: 'mac-1', fingerprint: 'f'.repeat(64), secret: 'S'.repeat(43), expiresAt: '2026-11-17T12:02:00.000Z', origin: 'https://192.168.1.20:52000', ttlMs: 120_000, certificateFingerprint: PIN }
const NOW = Date.parse('2026-11-17T12:00:00.000Z')

function memory() {
    const values = new Map<string, string>()
    return { getItem: async (key: string) => values.get(key) ?? null, setItem: async (key: string, value: string) => void values.set(key, value), removeItem: async (key: string) => void values.delete(key), values }
}

const parser = createMacPairingClient({ storage: memory() })

describe('readMacOffer', () => {
    it('reads the code under the QR, as text or as a link', () => {
        expect(readMacOffer(parser, JSON.stringify(OFFER), NOW)).toMatchObject({ ok: true, offer: { origin: OFFER.origin } })
        expect(readMacOffer(parser, `  ${parser.encodeOfferLink(OFFER as never)}  `, NOW)).toMatchObject({ ok: true, offer: { secret: OFFER.secret, certificateFingerprint: PIN } })
    })

    it('refuses what is not a pairing code', () => {
        for (const input of ['', 'hello', '192.168.1.20', '{"kind":"other"}', 'https://example.com', JSON.stringify({ ...OFFER, secret: 'short' }), JSON.stringify({ ...OFFER, kind: 'something-else' })]) {
            expect(readMacOffer(parser, input, NOW)).toMatchObject({ ok: false, problem: 'invalid' })
        }
    })

    it('refuses a Mac that is not on the local network, or that asks for plain HTTP there', () => {
        for (const change of [{ origin: 'https://203.0.113.9:52000' }, { origin: 'https://mac.example.com:52000' }, { origin: 'http://192.168.1.20:52000' }, { origin: 'http://192.168.1.20:52000', certificateFingerprint: undefined }, { certificateFingerprint: undefined }]) {
            expect(readMacOffer(parser, JSON.stringify({ ...OFFER, ...change }), NOW)).toMatchObject({ ok: false, problem: 'invalid' })
        }
    })

    it('says an offer has run out before asking the Mac', () => {
        expect(readMacOffer(parser, JSON.stringify(OFFER), NOW + 121_000)).toMatchObject({ ok: false, problem: 'expired' })
    })
})

describe('pairWithMac', () => {
    const offer = readMacOffer(parser, JSON.stringify(OFFER), NOW) as Extract<ReturnType<typeof readMacOffer>, { ok: true }>
    const credential = 'C'.repeat(43)
    const deviceId = '7d9f1b3c-5e7a-4c1d-8f2b-4a6c8e0b2d4f'

    function macThatAnswers(statuses: (object | Error)[], redeem: object | Error = { status: 'pending', deviceId, requestToken: 'R'.repeat(43), workspaceId: 1 }) {
        const storage = memory()
        const calls: { url: string; pin: string; body: unknown }[] = []
        const pinnedFetch = jest.fn(async (url: string, pin: string, options: { body?: string }) => {
            calls.push({ url, pin, body: options.body ? JSON.parse(options.body) : undefined })
            const answer = url.endsWith('/pair/redeem') ? redeem : statuses.shift()!
            if (answer instanceof Error) throw answer
            const status = 'error' in answer ? ((answer as { httpStatus?: number }).httpStatus ?? 401) : 200
            return { ok: status === 200, status, json: async () => answer }
        })
        return { client: createMacPairingClient({ storage, pinnedFetch, deviceName: 'Test phone' }), storage, calls }
    }

    it('waits for the approval, then holds the token the Mac handed over', async () => {
        const approved = { status: 'approved', deviceId, workspaceId: 1, macId: OFFER.macId, fingerprint: OFFER.fingerprint, credential }
        const { client, storage, calls } = macThatAnswers([{ status: 'pending', deviceId, workspaceId: 1 }, approved])
        const onWaiting = jest.fn()
        expect(await pairWithMac(client, offer, { signal: new AbortController().signal, onWaiting, pollMs: 1 })).toEqual({ ok: true })
        expect(onWaiting).toHaveBeenCalledTimes(1)
        // Every request went to the offer's address with the offer's certificate, and the secret left once.
        expect(calls.every(call => call.url.startsWith(`${OFFER.origin}/api/mac-pairing/v1/pair/`) && call.pin === PIN)).toBe(true)
        expect(calls.filter(call => JSON.stringify(call.body).includes(OFFER.secret))).toHaveLength(1)
        const link = parseMacLink([...storage.values.values()][0])
        expect(link).toMatchObject({ origin: OFFER.origin, certificateFingerprint: PIN, workspaceId: 1, deviceId, credential })
        expect(JSON.stringify([...storage.values.values()])).not.toContain(OFFER.secret)
    })

    it('says so when the code is wrong, used or expired, and keeps nothing', async () => {
        const { client, storage } = macThatAnswers([], { error: 'invalid_offer' })
        expect(await pairWithMac(client, offer, { signal: new AbortController().signal, onWaiting: jest.fn(), pollMs: 1 })).toMatchObject({ ok: false, problem: 'expired' })
        expect(storage.values.size).toBe(0)
    })

    it('says so when phone access is off, or the Mac cannot be reached', async () => {
        const off = macThatAnswers([], { error: 'disabled', httpStatus: 403 })
        expect(await pairWithMac(off.client, offer, { signal: new AbortController().signal, onWaiting: jest.fn(), pollMs: 1 })).toMatchObject({ ok: false, problem: 'off' })
        const away = macThatAnswers([], new TypeError('Network request failed'))
        expect(await pairWithMac(away.client, offer, { signal: new AbortController().signal, onWaiting: jest.fn(), pollMs: 1 })).toMatchObject({ ok: false, problem: 'unreachable' })
    })

    it('forgets a request the Mac declined', async () => {
        const { client, storage } = macThatAnswers([{ status: 'pending', deviceId, workspaceId: 1 }, { status: 'revoked' }])
        expect(await pairWithMac(client, offer, { signal: new AbortController().signal, onWaiting: jest.fn(), pollMs: 1 })).toMatchObject({ ok: false, problem: 'declined' })
        expect(storage.values.size).toBe(0)
    })

    it('forgets a request the person walked away from', async () => {
        const controller = new AbortController()
        const { client, storage } = macThatAnswers(Array.from({ length: 50 }, () => ({ status: 'pending', deviceId, workspaceId: 1 })))
        const result = pairWithMac(client, offer, { signal: controller.signal, onWaiting: () => controller.abort(), pollMs: 1 })
        expect(await result).toMatchObject({ ok: false, problem: 'cancelled' })
        expect(storage.values.size).toBe(0)
    })

    it('cannot pair over the local network in a build without the pinned transport', async () => {
        const client = createMacPairingClient({ storage: memory() })
        expect(await pairWithMac(client, offer, { signal: new AbortController().signal, onWaiting: jest.fn(), pollMs: 1 })).toMatchObject({ ok: false, problem: 'unsupported' })
        expect(pairingProblemOf(new Error('pinned_transport_required'))).toBe('unsupported')
    })
})

describe('parseMacLink', () => {
    const saved = { kind: 'rerun-mac-phone-pairing', status: 'approved', origin: OFFER.origin, certificateFingerprint: PIN, macId: 'mac-1', fingerprint: OFFER.fingerprint, workspaceId: 1, deviceId: 'device-1', credential: 'C'.repeat(43) }

    it('is a link only once the Mac approved the phone', () => {
        expect(parseMacLink(JSON.stringify(saved))).toMatchObject({ origin: OFFER.origin, credential: saved.credential, workspaceId: 1 })
        expect(parseMacLink(JSON.stringify({ ...saved, status: 'pending', credential: undefined, requestToken: 'R'.repeat(43) }))).toBeNull()
        for (const raw of [null, '', 'not json', '{}', JSON.stringify({ ...saved, kind: 'other' }), JSON.stringify({ ...saved, workspaceId: '1' }), JSON.stringify({ ...saved, credential: 1 })]) expect(parseMacLink(raw)).toBeNull()
    })
})

describe('pairWithMac detail', () => {
    it('keeps what the phone itself reported beside the problem', async () => {
        const client = { connectToThisMac: jest.fn().mockRejectedValue(Object.assign(new Error('The request timed out.'), {})), waitForApproval: jest.fn(), clearMacSession: jest.fn() }
        const result = await pairWithMac(client as never, { ok: true, offer: {} as never }, { signal: new AbortController().signal, onWaiting: () => {} })
        expect(result).toEqual({ ok: false, problem: 'unreachable', detail: 'The request timed out.' })
    })
})
