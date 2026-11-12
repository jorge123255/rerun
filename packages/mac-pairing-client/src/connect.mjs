import { API_PREFIX, SERVICE_NAME } from './protocol.mjs'
import { createMacSessionStore } from './session-store.mjs'

function pairingOrigin(origin, certificateFingerprint) {
    if (typeof origin !== 'string') throw new Error('invalid_origin')
    const parsed = new URL(origin)
    if (parsed.origin !== origin || !parsed.port) throw new Error('invalid_origin')
    if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && !certificateFingerprint) return origin
    const privateAddress = /^(?:10\.\d+|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+$/.test(parsed.hostname)
    if (parsed.protocol === 'https:' && privateAddress && typeof certificateFingerprint === 'string'
        && /^[0-9a-f]{64}$/.test(certificateFingerprint)) return origin
    throw new Error('invalid_origin')
}

function parseOffer(input) {
    if (input && typeof input === 'object') return input
    if (typeof input !== 'string') throw new Error('invalid_offer')
    const typed = input.trim()
    if (!typed) throw new Error('invalid_offer')
    if (typed.startsWith('{')) return JSON.parse(typed)
    const url = new URL(typed)
    if (url.protocol !== 'rerun-mac:' || url.hostname !== 'pair') throw new Error('invalid_offer')
    return {
        version: Number(url.searchParams.get('v')),
        kind: SERVICE_NAME,
        offerId: url.searchParams.get('offer'),
        workspaceId: Number(url.searchParams.get('workspace')),
        macId: url.searchParams.get('mac'),
        fingerprint: url.searchParams.get('fp'),
        certificateFingerprint: url.searchParams.get('tls') ?? undefined,
        secret: url.searchParams.get('secret'),
        origin: url.searchParams.get('origin'),
        expiresAt: url.searchParams.get('exp'),
    }
}

async function request(connection, path, { method = 'GET', body, credential, fetchImpl, pinnedFetch } = {}) {
    const { origin, certificateFingerprint } = connection
    const url = `${pairingOrigin(origin, certificateFingerprint)}${API_PREFIX}${path}`
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (credential) headers.Authorization = `Bearer ${credential}`
    const options = {
        method,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        body: body === undefined ? undefined : JSON.stringify(body),
    }
    if (certificateFingerprint && typeof pinnedFetch !== 'function') throw new Error('pinned_transport_required')
    const response = certificateFingerprint ? await pinnedFetch(url, certificateFingerprint, options) : await fetchImpl(url, options)
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
        const error = new Error(payload?.error ?? 'request_failed')
        error.status = response.status
        error.body = payload
        throw error
    }
    return payload
}

export function encodeOfferLink(offer) {
    const url = new URL('rerun-mac://pair')
    url.searchParams.set('v', String(offer.version ?? 1))
    url.searchParams.set('mac', offer.macId)
    url.searchParams.set('fp', offer.fingerprint)
    if (offer.certificateFingerprint) url.searchParams.set('tls', offer.certificateFingerprint)
    url.searchParams.set('offer', offer.offerId)
    url.searchParams.set('workspace', String(offer.workspaceId))
    url.searchParams.set('origin', offer.origin)
    url.searchParams.set('secret', offer.secret)
    if (offer.expiresAt) url.searchParams.set('exp', offer.expiresAt)
    return url.toString()
}

export function createMacPairingClient({ storage, fetch: fetchImpl = fetch, pinnedFetch, now = Date.now, deviceName = 'Test Phone' } = {}) {
    const sessions = createMacSessionStore(storage)

    async function sessionOrThrow() {
        const session = await sessions.read()
        if (!session?.credential || !session.origin) throw new Error('not_paired')
        return session
    }

    return {
        parseOffer,
        encodeOfferLink,
        async connectToThisMac(input) {
            const offer = parseOffer(input)
            if (offer.kind !== SERVICE_NAME || offer.version !== 1) throw new Error('invalid_offer')
            if (!offer.origin || !offer.macId || !offer.fingerprint || !offer.secret) throw new Error('invalid_offer')
            const pending = await request(offer, '/pair/redeem', {
                method: 'POST',
                fetchImpl, pinnedFetch,
                body: {
                    offerId: offer.offerId,
                    macId: offer.macId,
                    fingerprint: offer.fingerprint,
                    secret: offer.secret,
                    deviceName,
                },
            })
            if (pending?.status !== 'pending' || pending.workspaceId !== offer.workspaceId
                || typeof pending.deviceId !== 'string' || typeof pending.requestToken !== 'string') throw new Error('invalid_pairing_response')
            await sessions.write({
                kind: SERVICE_NAME,
                status: 'pending',
                origin: offer.origin,
                macId: offer.macId,
                fingerprint: offer.fingerprint,
                certificateFingerprint: offer.certificateFingerprint,
                workspaceId: pending.workspaceId,
                deviceId: pending.deviceId,
                requestToken: pending.requestToken,
                savedAt: new Date(now()).toISOString(),
            })
            return pending
        },
        async waitForApproval() {
            const session = await sessions.read()
            if (!session?.requestToken || !session.deviceId || !session.origin) throw new Error('not_paired')
            const result = await request(session, '/pair/status', {
                method: 'POST',
                fetchImpl, pinnedFetch,
                body: { deviceId: session.deviceId, requestToken: session.requestToken },
            })
            if (result.status === 'approved' && result.credential) {
                if (result.macId !== session.macId || result.fingerprint !== session.fingerprint
                    || result.workspaceId !== session.workspaceId || result.deviceId !== session.deviceId
                    || (result.origin !== undefined && result.origin !== session.origin)) throw new Error('invalid_pairing_response')
                await sessions.write({
                    kind: SERVICE_NAME,
                    status: 'approved',
                    origin: session.origin,
                    macId: session.macId,
                    fingerprint: session.fingerprint,
                    certificateFingerprint: session.certificateFingerprint,
                    workspaceId: result.workspaceId,
                    deviceId: result.deviceId,
                    credential: result.credential,
                    savedAt: new Date(now()).toISOString(),
                })
            }
            return result
        },
        async listCoworkers() {
            const session = await sessionOrThrow()
            return request(session, `/workspaces/${encodeURIComponent(session.workspaceId)}/coworkers`, { credential: session.credential, fetchImpl, pinnedFetch })
        },
        async listSavedChats(agentId) {
            const session = await sessionOrThrow()
            return request(session, `/workspaces/${encodeURIComponent(session.workspaceId)}/coworkers/${encodeURIComponent(agentId)}/chats`, { credential: session.credential, fetchImpl, pinnedFetch })
        },
        async openSavedChat(agentId, sessionId) {
            const session = await sessionOrThrow()
            return request(session, `/workspaces/${encodeURIComponent(session.workspaceId)}/coworkers/${encodeURIComponent(agentId)}/chats/${encodeURIComponent(sessionId)}`, { credential: session.credential, fetchImpl, pinnedFetch })
        },
        readMacSession: () => sessions.read(),
        clearMacSession: () => sessions.clear(),
    }
}
