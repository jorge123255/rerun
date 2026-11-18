import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { API_PREFIX, CREDENTIAL_CLAIM_TTL_MS, DEVICE_STATUS, ERRORS, LOOPBACK_HOST, PROTOCOL_VERSION, SERVICE_NAME } from './protocol.mjs'
import { hashSecret, hashesEqual, randomSecret } from './crypto.mjs'
import { callWorkspace, openWorkspaceStream, readWorkspaceChats, readWorkspaceReply, sendWorkspaceMessage, stopWorkspaceTurn } from './workspace-reads.mjs'
import { assertDeviceWorkspace, hiddenWorkspaceError } from './workspace-access.mjs'
import { coworkerSettingsResources } from './coworker-settings.mjs'
import { publicDevice } from './store.mjs'

const BODY_LIMIT = 16_384
const MESSAGE_BODY_LIMIT = 128 * 1024
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/
const ID = /^[A-Za-z0-9_-]{1,200}$/
const WORKSPACE = /^[1-9]\d*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function phoneUuid(parts) {
    const bytes = createHash('sha256').update(JSON.stringify(parts)).digest()
    bytes[6] = (bytes[6] & 0x0f) | 0x80
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = bytes.subarray(0, 16).toString('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function phoneRunId(device, agentId, chatId, requestId) {
    return phoneUuid(['rerun-mac-phone-turn-v1', device.deviceId, agentId, chatId, requestId.toLowerCase()])
}

function send(response, status, body) {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    })
    response.end(payload)
}

function fail(response, code, status = 401) {
    send(response, status, { error: code })
}

// What a phone may ask for beyond coworkers and their chats, by method and name under its workspace.
// Each is served by the Mac app's route of the same name, and only to a phone that holds `needs`.
// Anything not listed here does not exist for a phone.
const RESOURCES = new Map([
    ...coworkerSettingsResources,
    ['GET inbox', { to: 'inbox' }],
    // Marking a row read changes the Mac's own inbox: a phone that only reads changes nothing.
    ['POST inbox/read', { to: 'inbox', needs: 'sendMessages' }],
    // The Chief of Staff: General and its task threads, read as text by any approved phone. `grant`
    // adds what this phone may do to the answer. Sending, answering its question and stopping take
    // the send permission. Its cards that change things are words only: no entry here settles one.
    ['GET chief', { to: 'chief', grant: 'sendMessages' }],
    ['GET chief/chat', { to: 'chief/chat', grant: 'sendMessages', query: chiefChat }],
    ['GET chief/turn', { to: 'chief/turn', query: chiefTurn }],
    ['GET chief/stream', { to: 'chief/stream', query: chiefTurn, stream: true }],
    ['POST chief/send', { to: 'chief/send', needs: 'sendMessages', limit: MESSAGE_BODY_LIMIT, body: chiefSend }],
    ['POST chief/answer', { to: 'chief/answer', needs: 'sendMessages', limit: MESSAGE_BODY_LIMIT, body: chiefAnswer }],
    ['POST chief/stop', { to: 'chief/stop', needs: 'sendMessages', body: chiefStop }],
    // A voice conversation with the Chief of Staff speaks for the phone's owner: it takes the right to
    // send. Each one starts an ElevenLabs session billed to the owner, so a phone gets a few a minute.
    ['POST voice/start', { to: 'voice/start', needs: 'sendMessages', limit: 1_000, rate: { count: 3, perMs: 60_000 } }],
])
const RESOURCE_PATH = /^\/workspaces\/([^/]+)\/([a-z-]+(?:\/[a-z-]+)?)$/
const REFUSALS = { sendMessages: 'send_not_allowed', approveRequests: 'approve_not_allowed', changeSettings: 'settings_not_allowed' }

function validDecisions(approval) {
    if (!approval || typeof approval !== 'object' || Array.isArray(approval) || Object.keys(approval).length !== 2) return false
    if (typeof approval.toolCallId !== 'string' || !approval.toolCallId || approval.toolCallId.length > 256) return false
    return Array.isArray(approval.decisions) && approval.decisions.length >= 1 && approval.decisions.length <= 20 && approval.decisions.every(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false
        const keys = Object.keys(item)
        if (item.decision === 'approved') return keys.length === 1
        return item.decision === 'declined' && keys.every(key => key === 'decision' || key === 'note') && (item.note === undefined || (typeof item.note === 'string' && item.note.length <= 20_000))
    })
}

function validAnswer(answer) {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false
    const keys = Object.keys(answer)
    if (typeof answer.toolCallId !== 'string' || !answer.toolCallId || answer.toolCallId.length > 256) return false
    if (answer.answers === undefined) return keys.length === 1
    return keys.length === 2 && Array.isArray(answer.answers) && answer.answers.length >= 1 && answer.answers.length <= 32
        && answer.answers.every(values => Array.isArray(values) && values.length <= 100 && values.every(value => typeof value === 'string' && value.length <= 4000))
}

// A conversation with the Chief of Staff, by the id the Mac gave it.
const CHIEF_CHAT = /^fmc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const only = (value, required, optional = []) => {
    const keys = Object.keys(value)
    return required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key))
}
// The Mac's id for the turn a phone started with the Chief of Staff. It is made from the phone and
// the id the phone chose, so a phone can only ever name, follow or stop a turn of its own.
const chiefRun = (device, requestId) => phoneUuid(['rerun-mac-phone-chief-turn-v1', device.deviceId, requestId.toLowerCase()])

function chiefChat(_device, query) {
    const chat = query.get('chat')
    return [...query.keys()].length === 1 && chat && CHIEF_CHAT.test(chat) ? { chatId: chat } : null
}

function chiefTurn(device, query) {
    const chat = query.get('chat'), request = query.get('request')
    return [...query.keys()].length === 2 && chat && CHIEF_CHAT.test(chat) && request && UUID.test(request) ? { chatId: chat, runId: chiefRun(device, request) } : null
}

// A message: to the conversation named, to a new task thread, or to General when neither is.
function chiefSend(device, body) {
    if (!only(body, ['requestId', 'text'], ['chatId', 'thread']) || typeof body.requestId !== 'string' || !UUID.test(body.requestId)
        || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20_000
        || (body.chatId !== undefined && (typeof body.chatId !== 'string' || !CHIEF_CHAT.test(body.chatId)))
        || (body.thread !== undefined && (body.thread !== true || body.chatId !== undefined))) return null
    const runId = chiefRun(device, body.requestId)
    const newChatRequestId = body.thread ? phoneUuid(['rerun-mac-phone-chief-chat-v1', device.deviceId, body.requestId.toLowerCase()]) : undefined
    return {
        send: { runId, text: body.text, ...(body.chatId && { chatId: body.chatId }), ...(newChatRequestId && { newChatRequestId }) },
        receipt: taken => taken?.runId === runId && typeof taken.chatId === 'string' && CHIEF_CHAT.test(taken.chatId)
            && (!body.chatId || taken.chatId === body.chatId) && (!newChatRequestId || taken.chatId === `fmc_${newChatRequestId}`)
            ? { requestId: body.requestId, chatId: taken.chatId } : null,
    }
}

// The answer to the question a conversation waits on, or its dismissal when `answers` is left out.
function chiefAnswer(device, body) {
    if (!only(body, ['chatId', 'requestId', 'toolCallId'], ['answers']) || typeof body.chatId !== 'string' || !CHIEF_CHAT.test(body.chatId)
        || typeof body.requestId !== 'string' || !UUID.test(body.requestId)
        || !validAnswer({ toolCallId: body.toolCallId, ...(body.answers !== undefined && { answers: body.answers }) })) return null
    const runId = chiefRun(device, body.requestId)
    return {
        send: { chatId: body.chatId, runId, toolCallId: body.toolCallId, ...(body.answers && { answers: body.answers }) },
        receipt: taken => taken?.runId === runId ? { requestId: body.requestId } : null,
    }
}

function chiefStop(device, body) {
    if (!only(body, ['chatId', 'requestId']) || typeof body.chatId !== 'string' || !CHIEF_CHAT.test(body.chatId)
        || typeof body.requestId !== 'string' || !UUID.test(body.requestId)) return null
    const runId = chiefRun(device, body.requestId)
    return { send: { chatId: body.chatId, runId }, receipt: taken => taken?.runId === runId ? { requestId: body.requestId } : null }
}

async function streamReply(response, open, authorize) {
    const disconnected = new AbortController()
    const close = () => disconnected.abort()
    response.once('close', close)
    const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(60_000)])
    let reader
    try {
        const body = await open(signal)
        reader = body?.getReader()
        await authorize(() => {
            signal.throwIfAborted()
            if (!reader) return response.writeHead(204, { 'cache-control': 'no-store' }).end()
            response.writeHead(200, {
                'content-type': 'application/x-ndjson',
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
            })
            response.flushHeaders()
        })
        while (reader && !signal.aborted) {
            const { value, done } = await reader.read()
            if (done) break
            const writable = await authorize(() => {
                signal.throwIfAborted()
                return response.write(value)
            })
            if (!writable) await once(response, 'drain', { signal })
        }
        if (!response.destroyed && !response.writableEnded) response.end()
    } catch (error) {
        if (!response.headersSent && !response.destroyed) throw error
        if (!response.destroyed) response.end()
    } finally {
        response.off('close', close)
        void reader?.cancel().catch(() => {})
        disconnected.abort()
    }
}

async function readBody(request, limit = BODY_LIMIT) {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') return null
    try {
        const chunks = []
        let size = 0
        for await (const chunk of request) {
            size += chunk.length
            if (size > limit) return null
            chunks.push(chunk)
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch { return null }
}

export function createPairingTransport({
    now = Date.now, host = LOOPBACK_HOST, port = 0, installId, fingerprint, tls,
    getSettings, getStore, saveStore, getRuntime, dataRoot, offers, exclusive,
}) {
    const claims = new Map()
    const recent = new Map()
    let closing = false
    // At most `rate.count` requests to one resource per phone in any `rate.perMs`.
    function withinRate(deviceId, spec) {
        if (!spec.rate) return true
        const at = now(), key = `${deviceId} ${spec.to}`
        const kept = (recent.get(key) ?? []).filter(time => at - time < spec.rate.perMs)
        if (kept.length >= spec.rate.count) { recent.set(key, kept); return false }
        kept.push(at)
        recent.set(key, kept)
        if (recent.size > 1000) for (const [name, times] of recent) if (!times.some(time => at - time < spec.rate.perMs)) recent.delete(name)
        return true
    }
    const certificateFingerprint = tls?.certificateFingerprint
    const inScope = device => device.certificateFingerprint === certificateFingerprint
    function activeClaim(deviceId) {
        const claim = claims.get(deviceId)
        return claim && claim.expiresAt > now() && claim.runtime === getRuntime() ? claim : null
    }

    function address() {
        const value = server.address()
        if (closing || !value || typeof value === 'string') return null
        return { host: value.address, port: value.port, origin: `${tls ? 'https' : 'http'}://${value.address}:${value.port}` }
    }

    async function enabled() {
        if (closing) return false
        const settings = await getSettings()
        return !closing && settings.phoneAccessEnabled
            && (tls ? settings.lanBindingEnabled && settings.lanAddress === host : !settings.lanBindingEnabled)
    }

    async function authenticate(presented) {
        if (!presented || !(await enabled())) return null
        const store = await getStore()
        return store.devices.find(device => inScope(device) && device.status === DEVICE_STATUS.approved
            && device.credentialIssued !== false && hashesEqual(device.credentialHash, presented)) ?? null
    }

    // A phone the person removed is told so, once it proves it held that phone's token: it can then
    // forget the Mac instead of asking forever. Anyone else learns nothing more than `unauthorized`.
    async function removed(presented) {
        if (!presented || !(await enabled())) return false
        const store = await getStore()
        return store.devices.some(device => inScope(device) && device.status === DEVICE_STATUS.revoked && hashesEqual(device.credentialHash, presented))
    }

    async function workspaceFor(device, requested, current) {
        await assertDeviceWorkspace({
            dataRoot, installId, device, requestedWorkspaceId: requested, selectedWorkspaceId: current?.workspaceId,
        })
        if (getRuntime() !== current) throw hiddenWorkspaceError()
    }

    async function redeem(response, body) {
        if (!(await enabled())) return fail(response, ERRORS.disabled, 403)
        const current = getRuntime()
        const offer = offers.redeem(body, current)
        if (!current || !offer || offer.origin !== address()?.origin || offer.workspaceId !== current.workspaceId) return fail(response, ERRORS.invalid_offer)
        const store = await getStore()
        if (getRuntime() !== current) return fail(response, ERRORS.invalid_offer)
        const requestToken = randomSecret()
        const device = {
            deviceId: randomUUID(),
            workspaceId: offer.workspaceId,
            name: typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 80) || null : null,
            credentialHash: null,
            requestTokenHash: hashSecret(requestToken),
            status: DEVICE_STATUS.pending,
            createdAt: new Date(now()).toISOString(),
            approvedAt: null,
            revokedAt: null,
            lastSeenAt: null,
            ...(certificateFingerprint ? { certificateFingerprint } : {}),
        }
        store.devices.push(device)
        await saveStore(store)
        send(response, 200, { status: device.status, deviceId: device.deviceId, requestToken, workspaceId: device.workspaceId })
    }

    async function claimStatus(response, body) {
        if (!(await enabled())) return fail(response, ERRORS.disabled, 403)
        const presented = hashSecret(body.requestToken)
        const store = await getStore()
        const device = store.devices.find(entry => entry.deviceId === body.deviceId)
        if (!device || !inScope(device) || !hashesEqual(device.requestTokenHash, presented)) return fail(response, ERRORS.unauthorized)
        if (device.status === DEVICE_STATUS.revoked || (device.status === DEVICE_STATUS.pending
            && now() - Date.parse(device.createdAt) >= CREDENTIAL_CLAIM_TTL_MS)) {
            return send(response, 200, { status: DEVICE_STATUS.revoked })
        }
        const common = { status: device.status, deviceId: device.deviceId, workspaceId: device.workspaceId }
        if (device.status === DEVICE_STATUS.pending) return send(response, 200, common)
        const claim = activeClaim(device.deviceId)
        if (!claim) {
            claims.delete(device.deviceId)
            return send(response, 200, { status: DEVICE_STATUS.revoked })
        }
        device.credentialIssued = true
        await saveStore(store)
        if (!activeClaim(device.deviceId)) {
            device.credentialIssued = false
            await saveStore(store)
            claims.delete(device.deviceId)
            return send(response, 200, { status: DEVICE_STATUS.revoked })
        }
        claims.delete(device.deviceId)
        return send(response, 200, { ...common, macId: installId, fingerprint, credential: claim.credential })
    }

    async function resource(request, response, rawWorkspaceId, spec, search) {
        const presented = hashSecret(BEARER.exec(request.headers.authorization ?? '')?.[1])
        const device = await authenticate(presented)
        if (!device) return fail(response, await removed(presented) ? ERRORS.revoked : ERRORS.unauthorized)
        if (!WORKSPACE.test(rawWorkspaceId)) return fail(response, ERRORS.not_found, 404)
        // A resource takes only the query it lists, and one that lists none takes none.
        const query = spec.query ? spec.query(device, new URLSearchParams(search ?? '')) : undefined
        if (spec.query ? !query : search !== undefined) return fail(response, ERRORS.not_found, 404)
        const workspaceId = Number(rawWorkspaceId)
        const current = getRuntime()
        const permitted = candidate => !spec.needs || (Boolean(tls) && candidate[spec.needs] === true)
        // Revocation, a switch turned off and a workspace change can all land while the app answers:
        // the phone is checked again under the queue those changes share before anything is released.
        const recheck = async () => {
            const authorized = await authenticate(presented)
            if (!authorized || authorized.deviceId !== device.deviceId) { fail(response, ERRORS.unauthorized); return null }
            if (!permitted(authorized)) { fail(response, REFUSALS[spec.needs], 403); return null }
            await workspaceFor(authorized, workspaceId, current)
            return authorized
        }
        const release = (result, authorized) => {
            if (result.failure) {
                const { code, status, message } = result.failure
                return send(response, status, { error: code, ...(message && { message }) })
            }
            return send(response, 200, spec.grant
                ? { ...result.payload, permissions: { [spec.grant]: Boolean(tls && authorized[spec.grant] === true) } }
                : result.payload)
        }
        try {
            await workspaceFor(device, workspaceId, current)
            if (!permitted(device)) return fail(response, REFUSALS[spec.needs], 403)
            if (spec.stream) {
                if (!tls) return fail(response, ERRORS.not_found, 404)
                return await streamReply(response, signal => openWorkspaceStream(current, { resource: spec.to, query }, signal), publish => exclusive(async () => {
                    const authorized = await authenticate(presented)
                    if (!authorized || authorized.deviceId !== device.deviceId) throw Object.assign(new Error(ERRORS.unauthorized), { code: ERRORS.unauthorized })
                    await workspaceFor(authorized, workspaceId, current)
                    return publish()
                }))
            }
            if (request.method === 'GET') {
                const result = await callWorkspace(current, { resource: spec.to, query, settingsRefusals: spec.settingsRefusals })
                return await exclusive(async () => { const authorized = await recheck(); if (authorized) release(result, authorized) })
            }
            const body = await readBody(request, spec.limit ?? BODY_LIMIT)
            // What the app is sent is made here from what the phone sent, and so is what the phone is told.
            const turn = body && (spec.body ? spec.body(device, body) : { send: body })
            if (!turn) return fail(response, 'invalid_request', 400)
            if (!withinRate(device.deviceId, spec)) return fail(response, 'rate_limited', 429)
            return await exclusive(async () => {
                const authorized = await recheck()
                if (!authorized) return
                const result = await callWorkspace(current, { resource: spec.to, method: request.method, query, body: turn.send, settingsRefusals: spec.settingsRefusals })
                // Workspace switches run independently of the paired-device queue. A settings
                // receipt or refusal belongs to the same runtime that admitted the mutation.
                if (spec.needs === 'changeSettings' && getRuntime() !== current) throw hiddenWorkspaceError()
                if (result.failure || !turn.receipt) return release(result, authorized)
                const receipt = turn.receipt(result.payload)
                return receipt ? send(response, 200, receipt) : fail(response, 'unavailable', 502)
            })
        } catch (error) {
            if (error.code === ERRORS.not_found) fail(response, ERRORS.not_found, 404)
            else if (error.code === ERRORS.unauthorized) fail(response, ERRORS.unauthorized)
            else fail(response, 'unavailable', 502)
        }
    }

    async function handle(request, response) {
        // This bridge is for the phone client. Require the literal bound authority and
        // deny browser-origin requests so a web page cannot treat it as a CORS API.
        const bound = address()
        if (!bound || request.headers.host !== new URL(bound.origin).host || request.headers.origin) {
            return fail(response, ERRORS.not_found, 404)
        }
        const path = request.url ?? ''
        if (request.method === 'GET' && path === `${API_PREFIX}/meta`) {
            if (tls) return fail(response, ERRORS.not_found, 404)
            if (!(await enabled())) return fail(response, ERRORS.disabled, 403)
            return send(response, 200, {
                service: SERVICE_NAME, version: PROTOCOL_VERSION, macId: installId, fingerprint,
                phoneAccessEnabled: true, lanBindingEnabled: Boolean(tls),
            })
        }
        if (request.method === 'POST' && path === `${API_PREFIX}/pair/redeem`) {
            const body = await readBody(request)
            return body ? exclusive(() => redeem(response, body)) : fail(response, ERRORS.invalid_offer)
        }
        if (request.method === 'POST' && path === `${API_PREFIX}/pair/status`) {
            const body = await readBody(request)
            return body ? exclusive(() => claimStatus(response, body)) : fail(response, ERRORS.unauthorized)
        }

        const [pathname, search] = path.split(/\?(.*)/s)
        const named = pathname.startsWith(API_PREFIX) && RESOURCE_PATH.exec(pathname.slice(API_PREFIX.length))
        const spec = named && RESOURCES.get(`${request.method} ${named[2]}`)
        if (spec) return resource(request, response, named[1], spec, search)

        const route = path.startsWith(API_PREFIX) && /^\/workspaces\/([^/]+)\/coworkers(?:\/([^/]+)\/chats(?:\/([^/]+)(?:\/turns\/([^/]+)(\/stream)?)?)?)?$/.exec(path.slice(API_PREFIX.length))
        if (!route) return fail(response, ERRORS.not_found, 404)
        const [, rawWorkspaceId, agentId, chatId, requestId, streaming] = route
        const sending = request.method === 'POST' && agentId && !requestId
        const creating = sending && !chatId
        const stopping = request.method === 'DELETE' && requestId && !streaming
        if (!sending && !stopping && request.method !== 'GET') return fail(response, ERRORS.not_found, 404)
        const presented = hashSecret(BEARER.exec(request.headers.authorization ?? '')?.[1])
        const device = await authenticate(presented)
        if (!device) return fail(response, await removed(presented) ? ERRORS.revoked : ERRORS.unauthorized)
        if (!WORKSPACE.test(rawWorkspaceId) || (agentId && !ID.test(agentId)) || (chatId && !ID.test(chatId)) || (requestId && !UUID.test(requestId))) {
            return fail(response, ERRORS.not_found, 404)
        }
        const workspaceId = Number(rawWorkspaceId)
        const current = getRuntime()
        try {
            await workspaceFor(device, workspaceId, current)
            if (sending || stopping) {
                const body = sending ? await readBody(request, MESSAGE_BODY_LIMIT) : null
                const wantsApproval = Boolean(body && body.approval !== undefined)
                const allowed = candidate => Boolean(tls) && (wantsApproval ? candidate.approveRequests === true : candidate.sendMessages === true)
                const refusal = wantsApproval ? 'approve_not_allowed' : 'send_not_allowed'
                if (!allowed(device)) return fail(response, refusal, 403)
                // A turn is a message, or the answer to the question the chat waits on. Answering is sending:
                // it takes the same permission, and never opens a conversation.
                const answering = sending && !creating && body && body.text === undefined && validAnswer(body.answer)
                // A decision on the approval the chat waits on. It lets a coworker act, so it is a grant of
                // its own on this phone, and never rides on the right to send.
                const deciding = sending && !creating && body && body.text === undefined && body.answer === undefined && validDecisions(body.approval)
                if (sending && (!body || Object.keys(body).length !== 2 || typeof body.requestId !== 'string' || !UUID.test(body.requestId)
                    || (!answering && !deciding && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20_000)))) return fail(response, 'invalid_message', 400)
                return await exclusive(async () => {
                    const authorized = await authenticate(presented)
                    if (!authorized || authorized.deviceId !== device.deviceId) return fail(response, ERRORS.unauthorized)
                    if (!allowed(authorized)) return fail(response, refusal, 403)
                    await workspaceFor(authorized, workspaceId, current)
                    const turnRequestId = stopping ? requestId : body.requestId
                    const newChatId = creating ? phoneUuid(['rerun-mac-phone-chat-v1', authorized.deviceId, agentId, turnRequestId.toLowerCase()]) : undefined
                    const runId = phoneRunId(authorized, agentId, chatId ?? newChatId, turnRequestId)
                    const failure = stopping
                        ? await stopWorkspaceTurn(current, { agentId, chatId, runId })
                        : await sendWorkspaceMessage(current, { agentId, chatId, runId, newChatId, ...(answering ? { answer: body.answer } : deciding ? { approval: body.approval } : { text: body.text }) })
                    return failure ? fail(response, failure.code, failure.status) : send(response, stopping ? 200 : 202, { requestId: turnRequestId, ...(newChatId && { chatId: newChatId }) })
                })
            }
            const runId = requestId ? phoneRunId(device, agentId, chatId, requestId) : undefined
            if (streaming) {
                if (!tls) return fail(response, ERRORS.not_found, 404)
                return await streamReply(response, signal => readWorkspaceReply(current, { agentId, chatId, runId }, signal), publish => exclusive(async () => {
                    const authorized = await authenticate(presented)
                    if (!authorized || authorized.deviceId !== device.deviceId) throw Object.assign(new Error(ERRORS.unauthorized), { code: ERRORS.unauthorized })
                    await workspaceFor(authorized, workspaceId, current)
                    return publish()
                }))
            }
            const payload = await readWorkspaceChats(current, { agentId, chatId, runId })
            // Device revocation and workspace changes can finish during the network read.
            // The response is released under the same queue used for credential mutations.
            await exclusive(async () => {
                const authorized = await authenticate(presented)
                if (!authorized || authorized.deviceId !== device.deviceId) return fail(response, ERRORS.unauthorized)
                await workspaceFor(authorized, workspaceId, current)
                return send(response, 200, agentId && !requestId ? {
                    ...payload, permissions: {
                        sendMessages: Boolean(tls && authorized.sendMessages === true && (chatId ? payload.chat?.acceptsMessages : payload.acceptsMessages)),
                        approveRequests: Boolean(tls && authorized.approveRequests === true),
                    },
                } : payload)
            })
        } catch (error) {
            if (error.code === ERRORS.not_found) fail(response, ERRORS.not_found, 404)
            else if (error.code === ERRORS.unauthorized) fail(response, ERRORS.unauthorized)
            else fail(response, 'unavailable', 502)
        }
    }

    const serverOptions = { requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 1_000 }
    const onRequest = (request, response) => {
        handle(request, response).catch(() => {
            if (!response.headersSent) fail(response, 'unavailable', 500)
            else response.end()
        })
    }
    const server = tls
        ? createHttpsServer({ ...serverOptions, key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2', handshakeTimeout: 5000 }, onRequest)
        : createServer(serverOptions, onRequest)
    const sockets = new Set()
    server.maxConnections = 32
    server.on('connection', socket => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
    })

    return {
        address, certificateFingerprint, inScope,
        canClaim: device => inScope(device) && Boolean(activeClaim(device.deviceId)),
        async listen() {
            if (!tls && host !== LOOPBACK_HOST) throw Object.assign(new Error(ERRORS.lan_off), { code: ERRORS.lan_off })
            await new Promise((resolve, reject) => {
                server.once('error', reject)
                server.listen(port, host, () => { server.removeListener('error', reject); resolve() })
            })
        },
        async close() {
            closing = true
            claims.clear()
            if (!server.listening) return
            await new Promise((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve())
                for (const socket of sockets) socket.destroy()
            })
        },
        async approve(deviceId) {
            const current = getRuntime()
            const store = await getStore()
            const device = store.devices.find(entry => entry.deviceId === deviceId)
            const at = now()
            if (!device || !inScope(device) || device.status !== DEVICE_STATUS.pending || at - Date.parse(device.createdAt) >= CREDENTIAL_CLAIM_TTL_MS) {
                throw hiddenWorkspaceError()
            }
            await workspaceFor(device, device.workspaceId, current)
            const credential = randomSecret()
            device.credentialHash = hashSecret(credential)
            device.status = DEVICE_STATUS.approved
            device.credentialIssued = false
            device.approvedAt = new Date(at).toISOString()
            await saveStore(store)
            for (const [id, claim] of claims) if (claim.expiresAt <= at) claims.delete(id)
            claims.set(device.deviceId, { credential, runtime: current, expiresAt: at + CREDENTIAL_CLAIM_TTL_MS })
            return publicDevice(device)
        },
        async revoke(deviceId, { pendingOnly = false } = {}) {
            const current = getRuntime()
            const store = await getStore()
            const device = store.devices.find(entry => entry.deviceId === deviceId)
            if (!device) throw hiddenWorkspaceError()
            if (pendingOnly) {
                if (device.status !== DEVICE_STATUS.pending || !inScope(device)) throw hiddenWorkspaceError()
                await workspaceFor(device, device.workspaceId, current)
            }
            device.status = DEVICE_STATUS.revoked
            // A phone that is paired again starts without the right to decide approval requests.
            device.approveRequests = false
            device.changeSettings = false
            device.revokedAt = new Date(now()).toISOString()
            claims.delete(device.deviceId)
            await saveStore(store)
            return publicDevice(device)
        },
    }
}
