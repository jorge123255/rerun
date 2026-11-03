import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BoxDefaultModel, ConnectionSummary } from '@rerun/contracts'

// In-memory connection endpoints for exercising the desktop UI server against an HTTP engine.
export function connectionFixture() {
    const connections: ConnectionSummary[] = []
    let pick: BoxDefaultModel | null = null
    return (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => {
        const reply = (value: unknown, status = 200) => {
            res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
            return true
        }
        if (req.url === '/connections' && req.method === 'GET') return reply({ connections, default: pick })
        if (req.url === '/connections' && req.method === 'POST') {
            const c = { id: 'connection-' + (connections.length + 1), ...body, createdAt: '2026-01-01', connected: true, credentialRejected: false, planLimits: null } as ConnectionSummary
            const { id, name, provider, models, extraModels, createdAt, connected, credentialRejected, planLimits } = c
            connections.push({ id, name, provider, models, extraModels, createdAt, connected, credentialRejected, planLimits })
            pick ??= { connectionId: id, model: models[0] }
            return reply(connections.at(-1), 201)
        }
        if (req.url === '/connections/default' && req.method === 'PUT') {
            pick = { connectionId: String(body.connectionId), model: String(body.model) }
            return reply(pick)
        }
        if (req.url?.endsWith('/keys') && req.method === 'PATCH') return reply({ keys: Object.keys(body.set ?? {}) })
        return false
    }
}
