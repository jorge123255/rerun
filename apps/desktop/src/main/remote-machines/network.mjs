import { request as httpsRequest } from 'node:https'
import { lookup } from 'node:dns/promises'
import { checkServerIdentity as verifyCertificateName } from 'node:tls'
import { isIP } from 'node:net'
import { X509Certificate, createHash, randomUUID } from 'node:crypto'
import { LIMITS, identity, sameIdentity, refusal } from './protocol.mjs'

export function remoteAddress(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > LIMITS.addressBytes) throw refusal('invalid', 'Enter a secure server address.')
    let url
    try { url = new URL(raw.trim()) } catch { throw refusal('invalid', 'Enter a secure server address.') }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname
        || /[%\x00-\x20\x7f]/.test(url.hostname)) throw refusal('invalid', 'Use the server HTTPS origin without a path, credentials or query.')
    return url.origin
}
const normalize = ip => ip.toLowerCase().replace(/^::ffff:/, '')
export function approvedAddress(raw) {
    const ip = normalize(raw), family = isIP(ip)
    if (family === 4) {
        const [a, b] = ip.split('.').map(Number)
        return a !== 0 && a !== 127 && a < 224 && !(a === 169 && b === 254)
            && !(a === 192 && b === 0) && !(a === 198 && (b === 18 || b === 19))
    }
    // HTTPS private LAN / Tailscale addresses are deliberate manual destinations. Link-local,
    // loopback, multicast, unspecified and transition encodings cannot become a destination.
    return family === 6 && !ip.includes('%') && (/^(2|3)[0-9a-f]{3}:/.test(ip) || /^f[cd][0-9a-f]{2}:/.test(ip))
}
function certificateFingerprint(raw) {
    if (!raw) throw refusal('unavailable', 'The server certificate could not be verified.')
    return createHash('sha256').update(new X509Certificate(raw).publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
}
function peerFingerprint(socket) {
    if (!socket.authorized) throw refusal('unavailable', 'The server certificate could not be verified.')
    const raw = socket.getPeerCertificate()?.raw
    if (!raw) throw refusal('unavailable', 'The server certificate could not be verified.')
    return certificateFingerprint(raw)
}
async function abortable(work, signal) {
    signal.throwIfAborted()
    let abort
    try { return await Promise.race([work, new Promise((_, reject) => { abort = () => reject(refusal('cancelled', 'The server connection was cancelled.')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() })]) }
    finally { signal.removeEventListener('abort', abort) }
}
export function createPinnedRemoteNetwork({ resolve = host => lookup(host, { all: true, verbatim: true }), request = httpsRequest, inspectPeer = peerFingerprint } = {}) {
    async function json(origin, path, key, expectedPin, check, parentSignal) {
        origin = remoteAddress(origin)
        if (!['/health', '/connections'].includes(path) && !/^\/desktop\/remote-machine\/identity\?challenge=[0-9a-f-]{36}$/i.test(path)) throw refusal('unsupported', 'This remote request is unavailable.')
        const url = new URL(path, origin), host = url.hostname.replace(/^\[|\]$/g, '')
        const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(LIMITS.requestMs)])
        await check(); signal.throwIfAborted()
        const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(resolve(host), signal)
        signal.throwIfAborted(); await check()
        if (!Array.isArray(answers) || !answers.length || answers.length > LIMITS.addresses || answers.some(p => !approvedAddress(p.address) || isIP(p.address) !== p.family)) throw refusal('unavailable', 'This server address is not an approved network destination.')
        const pin = answers.slice().sort((a, b) => a.address.localeCompare(b.address))[0]
        return new Promise((resolveReply, reject) => {
            let req, response, completed = false, tlsPin = null, size = 0
            const chunks = []
            const finish = (error, value) => {
                if (completed) return
                completed = true; signal.removeEventListener('abort', abort)
                response?.destroy(); req?.destroy()
                if (error) reject(['unavailable', 'auth_needed', 'identity_changed', 'unsupported', 'cancelled'].includes(error.code) ? error : refusal('unavailable', 'The app cannot reach this server securely.'))
                else resolveReply(value)
            }
            const abort = () => finish(refusal('cancelled', 'The server connection was cancelled.'))
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) { abort(); return }
            try {
                req = request(url, {
                    method: 'GET', agent: false, rejectUnauthorized: true, autoSelectFamily: false, family: pin.family,
                    checkServerIdentity(name, cert) {
                        const error = verifyCertificateName(name, cert)
                        if (error) return error
                        try { if (expectedPin && certificateFingerprint(cert.raw) !== expectedPin) return refusal('identity_changed', 'The server certificate identity changed.') }
                        catch { return refusal('unavailable', 'The server certificate could not be verified.') }
                    },
                    ...(isIP(host) ? {} : { servername: host }),
                    lookup(_hostname, options, callback) { options?.all ? callback(null, [pin]) : callback(null, pin.address, pin.family) },
                    headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
                    signal,
                }, incoming => {
                    response = incoming
                    if (!tlsPin) { finish(refusal('unavailable', 'The secure server identity was not confirmed.')); return }
                    const status = incoming.statusCode ?? 0
                    if (status === 401 || status === 403) { finish(refusal('auth_needed', 'Your server answers, but refused the key.')); return }
                    if (status === 404 && path.startsWith('/desktop/remote-machine/identity')) { finish(refusal('unsupported', 'This server does not provide a verifiable workspace identity.')); return }
                    if (status < 200 || status >= 300 || incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity'
                        || !/^application\/json(?:\s*;|$)/i.test(String(incoming.headers['content-type'] ?? ''))) { finish(refusal('unavailable', 'The server did not provide a usable response.')); return }
                    incoming.on('data', part => { size += part.length; if (size > LIMITS.responseBytes) finish(refusal('unavailable', 'The server response exceeds its limit.')); else chunks.push(Buffer.from(part)) })
                    incoming.on('error', () => finish(refusal('unavailable', 'The server connection ended before acknowledgement.')))
                    incoming.on('aborted', () => finish(refusal('unavailable', 'The server connection ended before acknowledgement.')))
                    incoming.on('end', () => {
                        try { const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); finish(null, { body, tlsPin }) }
                        catch { finish(refusal('unavailable', 'The server response was malformed.')) }
                    })
                })
                req.on('socket', socket => {
                    socket.setTimeout(5000, () => finish(refusal('unavailable', 'The server connection timed out.')))
                    socket.once('secureConnect', () => {
                        try {
                            if (normalize(socket.remoteAddress ?? '') !== normalize(pin.address)) throw refusal('identity_changed', 'The server network identity changed.')
                            tlsPin = inspectPeer(socket)
                            if (expectedPin && tlsPin !== expectedPin) throw refusal('identity_changed', 'The server certificate identity changed. Review its configuration before reconnecting.')
                        } catch (error) { finish(error) }
                    })
                })
                req.on('error', error => finish(error.code === 'identity_changed' ? error : refusal(signal.aborted ? 'cancelled' : 'unavailable', signal.aborted ? 'The server connection was cancelled.' : 'The app cannot reach this server securely.')))
                req.end()
            } catch { finish(refusal('unavailable', 'The app cannot reach this server securely.')) }
        }).then(async reply => { signal.throwIfAborted(); await check(); return reply })
    }
    return { json }
}
export function createRemoteProtocolClient(network = createPinnedRemoteNetwork()) {
    return {
        async probe({ address, apiKey, expectedIdentity = null, tlsPin = null }, check, signal) {
            const origin = remoteAddress(address)
            if (typeof apiKey !== 'string' || apiKey.length < 16 || apiKey.length > LIMITS.keyBytes || /[^\x21-\x7e]/.test(apiKey) || origin.includes(apiKey)) throw refusal('invalid', 'Enter the address and the key of the server.')
            const health = await network.json(origin, '/health', null, tlsPin, check, signal)
            if (!health.body || health.body.status !== 'ok' || !Number.isSafeInteger(health.body.activeAgents) || health.body.activeAgents < 0 || health.body.activeAgents > 1000000) throw refusal('unavailable', 'The server health response was malformed.')
            // Original authentication proof, bounded and discarded: never expose provider config.
            const connections = await network.json(origin, '/connections', apiKey, health.tlsPin, check, signal)
            if (!connections.body || !Array.isArray(connections.body.connections) || connections.body.connections.length > 256) throw refusal('unavailable', 'The server authentication response was malformed.')
            const challenge = randomUUID()
            const proof = await network.json(origin, `/desktop/remote-machine/identity?challenge=${challenge}`, apiKey, health.tlsPin, check, signal)
            const remote = identity(proof.body?.identity)
            if (proof.body.challenge !== challenge || Object.keys(proof.body).some(k => !['identity', 'challenge'].includes(k))) throw refusal('identity_changed', 'The server identity acknowledgement changed.')
            if (remote.machineId.includes(apiKey)) throw refusal('unsupported', 'The server identity contained credential material.')
            if (expectedIdentity && !sameIdentity(expectedIdentity, remote)) throw refusal('identity_changed', 'This address now belongs to a different machine or workspace.')
            signal.throwIfAborted(); await check()
            return { address: origin, identity: remote, tlsPin: health.tlsPin,
                health: { state: 'connected', checkedAt: new Date().toISOString(), commit: typeof health.body.commit === 'string' && /^[0-9a-f]{7,64}$/i.test(health.body.commit) && !health.body.commit.includes(apiKey) ? health.body.commit : null,
                    activeAgents: health.body.activeAgents, reason: null } }
        },
    }
}
