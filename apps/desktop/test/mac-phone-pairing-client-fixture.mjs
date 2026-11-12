import { once } from 'node:events'
import { request } from 'node:http'
import { connect } from 'node:tls'

// The device must authenticate the TLS peer before sending any HTTP data.
export async function pinnedFetch(address, fingerprint, { method, headers, body, signal } = {}) {
    const url = new URL(address)
    if (url.protocol !== 'https:') throw new Error('https_required')
    const socket = connect({ host: url.hostname, port: Number(url.port), minVersion: 'TLSv1.2', rejectUnauthorized: false })
    const abort = () => socket.destroy()
    signal?.addEventListener('abort', abort, { once: true })
    try {
        await once(socket, 'secureConnect', { signal })
        const peer = socket.getPeerX509Certificate()
        if (peer?.fingerprint256.replaceAll(':', '').toLowerCase() !== fingerprint || peer.checkIP(url.hostname) !== url.hostname
            || !(Date.parse(peer.validFrom) <= Date.now() && Date.now() < Date.parse(peer.validTo))) throw new Error('untrusted_mac')
        return await new Promise((resolve, reject) => {
            const req = request({
                hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, signal,
                headers: { ...headers, Connection: 'close' },
                createConnection: () => socket,
            }, async res => {
                try {
                    const chunks = []
                    for await (const chunk of res) chunks.push(chunk)
                    if (res.statusCode >= 300 && res.statusCode < 400) throw new Error('redirect_refused')
                    resolve(new Response(Buffer.concat(chunks), { status: res.statusCode }))
                } catch (error) { reject(error) }
            })
            req.on('error', reject)
            req.end(body)
        })
    } finally {
        signal?.removeEventListener('abort', abort)
        socket.destroy()
    }
}
