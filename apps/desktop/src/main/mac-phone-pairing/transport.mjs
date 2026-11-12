import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { API_PREFIX, CREDENTIAL_CLAIM_TTL_MS, DEVICE_STATUS, ERRORS, LOOPBACK_HOST, PROTOCOL_VERSION, SERVICE_NAME } from './protocol.mjs'
import { hashSecret, hashesEqual, randomSecret } from './crypto.mjs'
import { readWorkspaceChats } from './workspace-reads.mjs'
import { assertDeviceWorkspace, hiddenWorkspaceError } from './workspace-access.mjs'
import { publicDevice } from './store.mjs'

const BODY_LIMIT = 16_384
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/
const ID = /^[A-Za-z0-9_-]{1,200}$/
const WORKSPACE = /^[1-9]\d*$/

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

async function readBody(request) {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') return null
    try {
        const chunks = []
        let size = 0
        for await (const chunk of request) {
            size += chunk.length
            if (size > BODY_LIMIT) return null
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

        const route = path.startsWith(API_PREFIX) && /^\/workspaces\/([^/]+)\/coworkers(?:\/([^/]+)\/chats(?:\/([^/]+))?)?$/.exec(path.slice(API_PREFIX.length))
        if (request.method !== 'GET' || !route) return fail(response, ERRORS.not_found, 404)
        const [, rawWorkspaceId, agentId, chatId] = route
        const presented = hashSecret(BEARER.exec(request.headers.authorization ?? '')?.[1])
        const device = await authenticate(presented)
        if (!device) return fail(response, ERRORS.unauthorized)
        if (!WORKSPACE.test(rawWorkspaceId) || (agentId && !ID.test(agentId)) || (chatId && !ID.test(chatId))) {
            return fail(response, ERRORS.not_found, 404)
        }
        const workspaceId = Number(rawWorkspaceId)
        const current = getRuntime()
        try {
            await workspaceFor(device, workspaceId, current)
            const payload = await readWorkspaceChats(current, { agentId, chatId })
            // Device revocation and workspace changes can finish during the network read.
            // The response is released under the same queue used for credential mutations.
            await exclusive(async () => {
                const authorized = await authenticate(presented)
                if (!authorized || authorized.deviceId !== device.deviceId) return fail(response, ERRORS.unauthorized)
                await workspaceFor(authorized, workspaceId, current)
                return send(response, 200, payload)
            })
        } catch (error) {
            if (error.code === ERRORS.not_found) fail(response, ERRORS.not_found, 404)
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
