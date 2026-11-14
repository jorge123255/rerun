import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { DesktopSubscriptionProvider } from '@rerun/contracts'

const deviceDestinations = {
    'grok-build': new Set(['auth.x.ai:443']),
    'kimi-code': new Set(['auth.kimi.ai:443', 'api.kimi.ai:443']),
    // Sign-in, feature flags and inference. Its error reporting host is left closed.
    devin: new Set(['app.devin.ai:443', 'api.devin.ai:443', 'windsurf.com:443', 'server.codeium.com:443', 'unleash.codeium.com:443', 'static.devin.ai:443']),
}
const catalogDestinations = {
    ...deviceDestinations,
    'grok-build': new Set([...deviceDestinations['grok-build'], 'cli-chat-proxy.grok.com:443']),
}
const dialVendor = (host: string) => connect({ host, port: 443 })

export function openDesktopSubscriptionDeviceRelay(provider: DesktopSubscriptionProvider, dial = dialVendor) {
    return openRelay(deviceDestinations[provider], dial)
}

export function openDesktopSubscriptionCatalogRelay(provider: DesktopSubscriptionProvider, dial = dialVendor) {
    return openRelay(catalogDestinations[provider], dial)
}

export function openDesktopSubscriptionTurnRelay(provider: DesktopSubscriptionProvider, dial = dialVendor) {
    // Grok answers through its chat proxy, the same host its model list comes from.
    return openRelay(provider === 'grok-build' ? catalogDestinations[provider] : deviceDestinations[provider], dial)
}

async function openRelay(destinations: ReadonlySet<string>, dial: typeof dialVendor) {
    const password = randomBytes(24).toString('hex')
    const expected = Buffer.from('Basic ' + Buffer.from('rerun:' + password).toString('base64'))
    const sockets = new Set<Socket>()
    let closing = false
    const server = createServer({ maxHeaderSize: 4096, headersTimeout: 5_000 }, (_request, response) => {
        response.writeHead(405).end()
    })
    server.maxConnections = 8
    const track = (socket: Socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
        socket.on('error', () => socket.destroy())
        socket.setTimeout(30_000, () => socket.destroy())
    }
    server.on('connection', track)
    server.on('connect', (request, stream, head) => {
        const socket = stream as Socket
        const target = request.url ?? ''
        const actual = Buffer.from(request.headers['proxy-authorization'] ?? '')
        if (closing || !destinations.has(target) ||
            actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
            return
        }
        // The request selects from a closed list of vendor TLS origins. TLS stays end to end.
        const upstream = dial(target.slice(0, -4))
        track(upstream)
        const close = () => { socket.destroy(); upstream.destroy() }
        socket.once('close', close)
        upstream.once('close', close)
        upstream.once('connect', () => {
            if (closing || socket.destroyed) { close(); return }
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if (head.length) upstream.write(head)
            upstream.pipe(socket).pipe(upstream)
        })
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject)
            resolve()
        })
    })
    server.on('error', () => { for (const socket of sockets) socket.destroy() })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Device sign-in relay failed.')
    let stopped: Promise<void> | undefined
    return {
        port: address.port,
        proxy: `http://rerun:${password}@127.0.0.1:${address.port}`,
        close(): Promise<void> {
            closing = true
            for (const socket of sockets) socket.destroy()
            return stopped ??= new Promise(resolve => server.close(() => resolve()))
        },
    }
}
