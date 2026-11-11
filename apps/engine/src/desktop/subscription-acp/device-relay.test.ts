import { once } from 'node:events'
import { connect, createServer } from 'node:net'
import { expect, test, vi } from 'vitest'
import { openDesktopSubscriptionCatalogRelay, openDesktopSubscriptionDeviceRelay } from './device-relay.js'

async function connectThrough(relay: { port: number; proxy: string }, target: string, authenticated = true) {
    const proxy = new URL(relay.proxy)
    const credential = Buffer.from(proxy.username + ':' + proxy.password).toString('base64')
    const socket = connect(relay.port, '127.0.0.1')
    try {
        await once(socket, 'connect')
        const response = once(socket, 'data')
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
            (authenticated ? `Proxy-Authorization: Basic ${credential}\r\n` : '') + '\r\n')
        return String((await response)[0])
    } finally {
        socket.destroy()
    }
}

test('permits only authenticated Grok catalog origins and keeps them off the device relay', async () => {
    const upstream = createServer()
    try {
        upstream.listen(0, '127.0.0.1')
        await once(upstream, 'listening')
        const address = upstream.address()
        if (!address || typeof address === 'string') throw new Error('Fixture did not bind to loopback')
        const dial = vi.fn(() => connect(address.port, '127.0.0.1'))
        const device = await openDesktopSubscriptionDeviceRelay('grok-build', dial)
        const catalog = await openDesktopSubscriptionCatalogRelay('grok-build', dial)
        try {
            const target = 'cli-chat-proxy.grok.com:443'
            expect(await connectThrough(device, target)).toContain('403 Forbidden')
            expect(await connectThrough(catalog, target, false)).toContain('403 Forbidden')
            expect(await connectThrough(catalog, 'api.x.ai:443')).toContain('403 Forbidden')
            expect(await connectThrough(catalog, 'api.kimi.ai:443')).toContain('403 Forbidden')
            expect(await connectThrough(catalog, '127.0.0.1:443')).toContain('403 Forbidden')
            expect(dial).not.toHaveBeenCalled()
            expect(await connectThrough(catalog, target)).toContain('200 Connection Established')
            expect(dial).toHaveBeenCalledExactlyOnceWith('cli-chat-proxy.grok.com')
        } finally {
            await Promise.all([device.close(), catalog.close()])
        }
    } finally {
        await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
})
