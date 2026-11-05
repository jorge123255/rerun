import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { desktopServiceRequestFingerprint, type DesktopServiceProgress } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { readDesktopServiceRequest, type ServiceRequestPorts } from '@/lib/desktop/server/service-requests/service'
import { rejectDesktopServiceRetry, reserveDesktopServiceRetry } from '@/lib/desktop/server/service-requests/retry'
import { GET, PUT } from './route'

test('a lost definitive refusal is recoverable after database reopen and identifies only the exact refused intent', async () => {
    const environment = { ...process.env }
    const root = await mkdtemp(join(tmpdir(), 'rerun-service-retry-api-'))
    const origin = 'http://127.0.0.1:3196', token = 'service-retry-fixture'.repeat(3)
    try {
        Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
        await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'retry-before-restart', buildId: 'test', workspaceId: 1, dataRoot: root,
            app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
        const db = await openDesktopDatabase(root)
        const agent = await createDesktopAgent(db, { engineAgentId: 'retry-owner', name: 'Retry owner' })
        const session = await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'retry-chat', title: 'Retry chat' })
        const services = [{ slug: 'notion' }]
        const scope = { agentId: agent.id, sessionId: session.id, enabled: true }
        const ports: ServiceRequestPorts = {
            source: async () => ({ sourceMessageId: 'source', toolCallId: 'call', services, fingerprint: desktopServiceRequestFingerprint(services) }),
            catalog: async () => ({ status: 'not-found' }), installations: async () => [],
            prepareSeal: async () => ({ installations: async () => [], check() {} }),
            send: async () => { throw new Error('Retry journal must never send a chat') },
        }
        const card = (await readDesktopServiceRequest(db, scope, ports)).request!
        const input: DesktopServiceProgress = { action: 'progress', requestId: crypto.randomUUID(), serviceRequestId: card.serviceRequestId,
            source: card.source, expectedRevision: card.revision, currentIndex: 0, choices: [{ slug: 'notion', choice: 'skip' }] }
        await reserveDesktopServiceRetry(db, scope, input)
        // The renderer did not receive this definitive rejection.
        expect(await rejectDesktopServiceRetry(db, scope, input)).toBe(true)
        await closeDesktopDatabase(root)
        const context = { params: Promise.resolve({ sessionId: session.id }) }
        const request = (body?: DesktopServiceProgress) => new Request(`${origin}/api/desktop/sessions/${session.id}/service-requests/retry?serviceRequestId=${card.serviceRequestId}`, {
            method: body ? 'PUT' : 'GET', headers: { host: new URL(origin).host, origin, cookie: `rerun-desktop-session=${token}`, 'content-type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
        })
        const restored = await GET(request(), context)
        expect(restored.status).toBe(200)
        expect(await restored.json()).toEqual({ attempt: null })
        const refused = await PUT(request(input), context)
        expect(refused.status).toBe(409)
        expect(refused.headers.get('x-service-request-outcome')).toBe('refused')
        expect(refused.headers.get('x-service-request-attempt-id')).toBe(input.requestId)
        expect(refused.headers.get('x-service-request-id')).toBe(card.serviceRequestId)
        const changed = await PUT(request({ ...input, choices: [{ slug: 'notion', choice: 'pending' }] }), context)
        expect(changed.status).toBe(409)
        expect(changed.headers.get('x-service-request-outcome')).toBeNull()
        const fresh = { ...input, requestId: crypto.randomUUID() }
        expect((await PUT(request(fresh), context)).status).toBe(200)
    } finally {
        await closeDesktopDatabase(root)
        process.env = environment
        await rm(root, { recursive: true, force: true })
    }
})
