import { API_PREFIX, SERVICE_NAME } from './protocol.mjs'
import { createMacSessionStore } from './session-store.mjs'

function pairingOrigin(origin, certificateFingerprint) {
    if (typeof origin !== 'string') throw new Error('invalid_origin')
    const parsed = new URL(origin)
    if (parsed.origin !== origin || !parsed.port) throw new Error('invalid_origin')
    if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && !certificateFingerprint) return origin
    const privateAddress = /^(?:10\.\d+|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d+\.\d+$/.test(parsed.hostname)
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

async function request(connection, path, { method = 'GET', body, credential, fetchImpl, pinnedFetch, signal } = {}) {
    const { origin, certificateFingerprint } = connection
    const url = `${pairingOrigin(origin, certificateFingerprint)}${API_PREFIX}${path}`
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (credential) headers.Authorization = `Bearer ${credential}`
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) throw new Error('aborted')
    signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, 10_000)
    const options = {
        method,
        headers,
        redirect: 'error',
        signal: controller.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
    }
    try {
        if (certificateFingerprint && typeof pinnedFetch !== 'function') throw new Error('pinned_transport_required')
        const response = certificateFingerprint ? await pinnedFetch(url, certificateFingerprint, options) : await fetchImpl(url, options)
        const payload = await response.json().catch(() => null)
        if (controller.signal.aborted) throw new Error('aborted')
        if (!response.ok) {
            const error = new Error(payload?.error ?? 'request_failed')
            error.status = response.status
            error.body = payload
            throw error
        }
        return payload
    } finally {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
    }
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

export function createMacPairingClient({ storage, fetch: fetchImpl = fetch, pinnedFetch, pinnedStream, now = Date.now, deviceName = 'Test Phone' } = {}) {
    const sessions = createMacSessionStore(storage)

    async function sessionOrThrow() {
        const session = await sessions.read()
        if (!session?.credential || !session.origin) throw new Error('not_paired')
        return session
    }

    function chatPath(session, agentId, chatId) {
        return `/workspaces/${encodeURIComponent(session.workspaceId)}/coworkers/${encodeURIComponent(agentId)}/chats/${encodeURIComponent(chatId)}`
    }

    async function chatRequest(agentId, chatId, suffix, options) {
        const session = await sessionOrThrow()
        return request(session, chatPath(session, agentId, chatId) + suffix, { ...options, credential: session.credential, fetchImpl, pinnedFetch })
    }

    async function chiefRequest(suffix, options) {
        const session = await sessionOrThrow()
        return request(session, `/workspaces/${encodeURIComponent(session.workspaceId)}/chief` + suffix, { ...options, credential: session.credential, fetchImpl, pinnedFetch })
    }

    return {
        parseOffer,
        encodeOfferLink,
        async connectToThisMac(input, signal) {
            const offer = parseOffer(input)
            if (offer.kind !== SERVICE_NAME || offer.version !== 1) throw new Error('invalid_offer')
            if (!offer.origin || !offer.macId || !offer.fingerprint || !offer.secret) throw new Error('invalid_offer')
            const pending = await request(offer, '/pair/redeem', {
                method: 'POST',
                fetchImpl, pinnedFetch, signal,
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
        async waitForApproval(signal) {
            const session = await sessions.read()
            if (!session?.requestToken || !session.deviceId || !session.origin) throw new Error('not_paired')
            const result = await request(session, '/pair/status', {
                method: 'POST',
                fetchImpl, pinnedFetch, signal,
                body: { deviceId: session.deviceId, requestToken: session.requestToken },
            })
            if (result?.status === 'approved') {
                if (typeof result.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.credential)
                    || result.macId !== session.macId || result.fingerprint !== session.fingerprint
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
            } else if (result?.status !== 'pending' && result?.status !== 'revoked') throw new Error('invalid_pairing_response')
            return result
        },
        async listCoworkers(signal) {
            const session = await sessionOrThrow()
            return request(session, `/workspaces/${encodeURIComponent(session.workspaceId)}/coworkers`, { credential: session.credential, fetchImpl, pinnedFetch, signal })
        },
        async listSavedChats(agentId, signal) {
            const session = await sessionOrThrow()
            return request(session, `/workspaces/${encodeURIComponent(session.workspaceId)}/coworkers/${encodeURIComponent(agentId)}/chats`, { credential: session.credential, fetchImpl, pinnedFetch, signal })
        },
        async startConversation(agentId, { requestId, text }, signal) {
            const session = await sessionOrThrow()
            const path = `/workspaces/${encodeURIComponent(session.workspaceId)}/coworkers/${encodeURIComponent(agentId)}/chats`
            const result = await request(session, path, { method: 'POST', body: { requestId, text }, credential: session.credential, fetchImpl, pinnedFetch, signal })
            if (result?.requestId !== requestId || typeof result.chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(result.chatId)) throw new Error('invalid_send_receipt')
            return result.chatId
        },
        async openSavedChat(agentId, sessionId, signal) {
            return chatRequest(agentId, sessionId, '', { signal })
        },
        async sendMessage(agentId, sessionId, { requestId, text }, signal) {
            const result = await chatRequest(agentId, sessionId, '', { method: 'POST', body: { requestId, text }, signal })
            if (result?.requestId !== requestId) throw new Error('invalid_send_receipt')
            return result
        },
        // Answers the question a saved chat waits on. `toolCallId` names the card the phone was shown;
        // `answers` holds the choices for each of its questions, and is left out to dismiss it.
        async answerQuestion(agentId, sessionId, { requestId, toolCallId, answers }, signal) {
            const result = await chatRequest(agentId, sessionId, '', { method: 'POST', body: { requestId, answer: { toolCallId, ...(answers && { answers }) } }, signal })
            if (result?.requestId !== requestId) throw new Error('invalid_send_receipt')
            return result
        },
        // Decides the approval a saved chat waits on: one decision for each action its card shows.
        // Needs the phone's "Approve requests" permission on the Mac.
        async decideApproval(agentId, sessionId, { requestId, toolCallId, decisions }, signal) {
            const result = await chatRequest(agentId, sessionId, '', { method: 'POST', body: { requestId, approval: { toolCallId, decisions } }, signal })
            if (result?.requestId !== requestId) throw new Error('invalid_send_receipt')
            return result
        },
        async readSentTurn(agentId, sessionId, requestId, signal) {
            const result = await chatRequest(agentId, sessionId, '/turns/' + encodeURIComponent(requestId), { signal })
            if (!['running', 'done', 'error', 'cancelled'].includes(result?.status)) throw new Error('invalid_turn_status')
            return result
        },
        async stopSentTurn(agentId, sessionId, requestId, signal) {
            const result = await chatRequest(agentId, sessionId, '/turns/' + encodeURIComponent(requestId), { method: 'DELETE', signal })
            if (result?.requestId !== requestId) throw new Error('invalid_stop_receipt')
        },
        async streamSentTurn(agentId, sessionId, requestId, onFrame, signal) {
            const session = await sessionOrThrow()
            const pin = session.certificateFingerprint
            if (!pin || typeof pinnedStream !== 'function') throw new Error('pinned_transport_required')
            const origin = pairingOrigin(session.origin, pin)
            const url = origin + API_PREFIX + chatPath(session, agentId, sessionId) + '/turns/' + encodeURIComponent(requestId) + '/stream'
            return pinnedStream(url, pin, 'Bearer ' + session.credential, onFrame, signal)
        },
        // The Mac's Actions inbox: what waits on the person and what finished since they last looked.
        async readInbox(signal) {
            const session = await sessionOrThrow()
            return request(session, `/workspaces/${encodeURIComponent(session.workspaceId)}/inbox`, { credential: session.credential, fetchImpl, pinnedFetch, signal })
        },
        // Marks rows read by the ids the inbox gave them. Needs the send permission.
        async markInboxRead(ids, signal) {
            const session = await sessionOrThrow()
            return request(session, `/workspaces/${encodeURIComponent(session.workspaceId)}/inbox/read`, { method: 'POST', body: { ids }, credential: session.credential, fetchImpl, pinnedFetch, signal })
        },
        // The Chief of Staff: whether it is ready or still asks its first-run questions on the Mac,
        // and the conversations someone wrote in.
        async readChief(signal) {
            return chiefRequest('', { signal })
        },
        // One of its conversations: messages as text, the question it waits on, the words of the
        // cards only the Mac settles.
        async openChiefChat(chatId, signal) {
            return chiefRequest('/chat?chat=' + encodeURIComponent(chatId), { signal })
        },
        // A message for it: in the conversation named, in a new task thread (`thread`), or in General
        // when neither is given. Answers the conversation it landed in. Needs the send permission.
        async sendToChief({ requestId, text, chatId, thread }, signal) {
            const result = await chiefRequest('/send', { method: 'POST', body: { requestId, text, ...(chatId && { chatId }), ...(thread && { thread: true }) }, signal })
            if (result?.requestId !== requestId || typeof result.chatId !== 'string' || !/^fmc_[0-9a-f-]{36}$/.test(result.chatId) || (chatId && result.chatId !== chatId)) throw new Error('invalid_send_receipt')
            return result.chatId
        },
        // Answers the question a conversation with it waits on, or dismisses it when `answers` is left out.
        async answerChief(chatId, { requestId, toolCallId, answers }, signal) {
            const result = await chiefRequest('/answer', { method: 'POST', body: { chatId, requestId, toolCallId, ...(answers && { answers }) }, signal })
            if (result?.requestId !== requestId) throw new Error('invalid_send_receipt')
            return result
        },
        async readChiefTurn(chatId, requestId, signal) {
            const result = await chiefRequest('/turn?chat=' + encodeURIComponent(chatId) + '&request=' + encodeURIComponent(requestId), { signal })
            if (!['running', 'done', 'error', 'cancelled'].includes(result?.status)) throw new Error('invalid_turn_status')
            return result
        },
        async stopChiefTurn(chatId, requestId, signal) {
            const result = await chiefRequest('/stop', { method: 'POST', body: { chatId, requestId }, signal })
            if (result?.requestId !== requestId) throw new Error('invalid_stop_receipt')
        },
        async streamChiefTurn(chatId, requestId, onFrame, signal) {
            const session = await sessionOrThrow()
            const pin = session.certificateFingerprint
            if (!pin || typeof pinnedStream !== 'function') throw new Error('pinned_transport_required')
            const url = pairingOrigin(session.origin, pin) + API_PREFIX + `/workspaces/${encodeURIComponent(session.workspaceId)}/chief/stream?chat=${encodeURIComponent(chatId)}&request=${encodeURIComponent(requestId)}`
            return pinnedStream(url, pin, 'Bearer ' + session.credential, onFrame, signal)
        },
        // A voice conversation with the Chief of Staff on one of its conversations: a short-lived token
        // for the phone's own WebRTC session with ElevenLabs, its id and when it lapses. Needs the send
        // permission and the Mac's own switch for it. The token is handed back, never kept here.
        async readVoiceChoices(signal) {
            const session = await sessionOrThrow()
            return request(session, `/workspaces/${encodeURIComponent(session.workspaceId)}/voice/choice`, { credential: session.credential, fetchImpl, pinnedFetch, signal })
        },
        async chooseVoice(voiceId, signal) {
            const session = await sessionOrThrow()
            return request(session, `/workspaces/${encodeURIComponent(session.workspaceId)}/voice/choice`, { method: 'POST', body: { voiceId }, credential: session.credential, fetchImpl, pinnedFetch, signal })
        },
        async startVoice(chatId, signal) {
            const session = await sessionOrThrow()
            const result = await request(session, `/workspaces/${encodeURIComponent(session.workspaceId)}/voice/start`, { method: 'POST', body: { chatId }, credential: session.credential, fetchImpl, pinnedFetch, signal })
            if (typeof result?.conversationToken !== 'string' || !result.conversationToken || typeof result.conversationId !== 'string' || typeof result.expiresAt !== 'string') throw new Error('invalid_voice_session')
            return { conversationToken: result.conversationToken, conversationId: result.conversationId, expiresAt: result.expiresAt }
        },
        readMacSession: () => sessions.read(),
        clearMacSession: () => sessions.clear(),
    }
}
