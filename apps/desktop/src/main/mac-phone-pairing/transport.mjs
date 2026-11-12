import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { API_PREFIX, CREDENTIAL_CLAIM_TTL_MS, DEVICE_STATUS, ERRORS, LOOPBACK_HOST, PROTOCOL_VERSION, SERVICE_NAME } from './protocol.mjs'
import { hashSecret, hashesEqual, randomSecret } from './crypto.mjs'
import { readWorkspaceChats, readWorkspaceReply, sendWorkspaceMessage, stopWorkspaceTurn } from './workspace-reads.mjs'
import { assertDeviceWorkspace, hiddenWorkspaceError } from './workspace-access.mjs'
import { publicDevice } from './store.mjs'

const BODY_LIMIT = 16_384
const MESSAGE_BODY_LIMIT = 128 * 1024
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/
const ID = /^[A-Za-z0-9_-]{1,200}$/
const WORKSPACE = /^[1-9]\d*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function phoneRunId(device, agentId, chatId, requestId) {
    const bytes = createHash('sha256').update(JSON.stringify(['rerun-mac-phone-turn-v1', device.deviceId, agentId, chatId, requestId.toLowerCase()])).digest()
    bytes[6] = (bytes[6] & 0x0f) | 0x80
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = bytes.subarray(0, 16).toString('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
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
    let closing = false
    const certificateFingerprint = tls?.certificateFingerprint
    const inScope = device => device.certificateFingerprint === certificateFingerprint

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
            && hashesEqual(device.credentialHash, presented)) ?? null
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
        const offer = offers.redeem(body)
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
        const claim = claims.get(device.deviceId)
        if (device.status === DEVICE_STATUS.revoked || (device.status === DEVICE_STATUS.pending
            && now() - Date.parse(device.createdAt) >= CREDENTIAL_CLAIM_TTL_MS)) {
            return send(response, 200, { status: DEVICE_STATUS.revoked })
        }
        const common = { status: device.status, deviceId: device.deviceId, workspaceId: device.workspaceId }
        if (device.status === DEVICE_STATUS.pending) return send(response, 200, common)
        if (!claim || claim.expiresAt <= now() || claim.runtime !== getRuntime()) {
            claims.delete(device.deviceId)
            return send(response, 200, { status: DEVICE_STATUS.revoked })
        }
        claims.delete(device.deviceId)
        return send(response, 200, { ...common, macId: installId, fingerprint, credential: claim.credential })
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

        const route = path.startsWith(API_PREFIX) && /^\/workspaces\/([^/]+)\/coworkers(?:\/([^/]+)\/chats(?:\/([^/]+)(?:\/turns\/([^/]+)(\/stream)?)?)?)?$/.exec(path.slice(API_PREFIX.length))
        if (!route) return fail(response, ERRORS.not_found, 404)
        const [, rawWorkspaceId, agentId, chatId, requestId, streaming] = route
        const sending = request.method === 'POST' && chatId && !requestId
        const stopping = request.method === 'DELETE' && requestId && !streaming
        if (!sending && !stopping && request.method !== 'GET') return fail(response, ERRORS.not_found, 404)
        const presented = hashSecret(BEARER.exec(request.headers.authorization ?? '')?.[1])
        const device = await authenticate(presented)
        if (!device) return fail(response, ERRORS.unauthorized)
        if (!WORKSPACE.test(rawWorkspaceId) || (agentId && !ID.test(agentId)) || (chatId && !ID.test(chatId)) || (requestId && !UUID.test(requestId))) {
            return fail(response, ERRORS.not_found, 404)
        }
        const workspaceId = Number(rawWorkspaceId)
        const current = getRuntime()
        try {
            await workspaceFor(device, workspaceId, current)
            if (sending || stopping) {
                if (!tls || device.sendMessages !== true) return fail(response, 'send_not_allowed', 403)
                const body = sending ? await readBody(request, MESSAGE_BODY_LIMIT) : null
                if (sending && (!body || Object.keys(body).length !== 2 || typeof body.requestId !== 'string' || !UUID.test(body.requestId)
                    || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20_000)) return fail(response, 'invalid_message', 400)
                return await exclusive(async () => {
                    const authorized = await authenticate(presented)
                    if (!authorized || authorized.deviceId !== device.deviceId) return fail(response, ERRORS.unauthorized)
                    if (authorized.sendMessages !== true) return fail(response, 'send_not_allowed', 403)
                    await workspaceFor(authorized, workspaceId, current)
                    const turnRequestId = stopping ? requestId : body.requestId
                    const runId = phoneRunId(authorized, agentId, chatId, turnRequestId)
                    const failure = stopping
                        ? await stopWorkspaceTurn(current, { agentId, chatId, runId })
                        : await sendWorkspaceMessage(current, { agentId, chatId, runId, text: body.text })
                    return failure ? fail(response, failure.code, failure.status) : send(response, stopping ? 200 : 202, { requestId: turnRequestId })
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
                return send(response, 200, chatId && !requestId ? {
                    ...payload, permissions: { sendMessages: Boolean(tls && authorized.sendMessages === true && payload.chat?.acceptsMessages) },
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
            device.approvedAt = new Date(at).toISOString()
            await saveStore(store)
            for (const [id, claim] of claims) if (claim.expiresAt <= at) claims.delete(id)
            claims.set(device.deviceId, { credential, runtime: current, expiresAt: at + CREDENTIAL_CLAIM_TTL_MS })
            return publicDevice(device)
        },
        async revoke(deviceId) {
            const store = await getStore()
            const device = store.devices.find(entry => entry.deviceId === deviceId)
            if (!device) throw hiddenWorkspaceError()
            device.status = DEVICE_STATUS.revoked
            device.revokedAt = new Date(now()).toISOString()
            claims.delete(device.deviceId)
            await saveStore(store)
            return publicDevice(device)
        },
    }
}
