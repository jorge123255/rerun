import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PUT as configureServer } from '@/app/api/desktop/coworkers/[agentId]/mcp/route'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { shutdownDesktopRemoteMcp } from '@/lib/desktop/server/mcp-binding'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { GET as readSignIn, POST as browserSignIn } from '../mcp-sign-in/route'
import { POST as deviceSignIn } from './route'

const transport = vi.hoisted(() => ({ discovery: vi.fn(), device: vi.fn() }))
vi.mock('@/lib/desktop/server/mcp/oauth-network', async original => ({
    ...await original<typeof import('@/lib/desktop/server/mcp/oauth-network')>(),
    discoverDeviceOAuth: transport.discovery, oauthDeviceForm: transport.device,
}))
vi.mock('@/lib/desktop/server/chat-model', () => ({
    resolveDesktopChatModel: vi.fn(async () => ({ connectionId: 'fixture-connection', model: 'fixture-model' })),
}))

it('uses the mounted Mac routes to resume a saved code after restart and continue only after probing tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-mounted-mcp-device-'))
    const runtimePath = join(root, 'runtime.json')
    const resource = 'https://fixture-mcp.example/mcp'
    const issuer = 'https://fixture-issuer.example/'
    const engineAgent = 'fixture-agent', engineSession = 'fixture-session'
    const privateToken = 'fixture-private-access-token', privateDeviceCode = 'fixture-private-device-code'
    const userCode = 'FIXTURE-HUMAN-ONLY'
    let runtime: DesktopRuntime = {
        protocolVersion: 1, buildId: 'fixture', launchNonce: randomUUID(), workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:41441', sessionToken: randomUUID() },
        engine: { origin: 'http://127.0.0.1:41442', apiKey: 'fixture-engine-key' },
    }
    let now = Date.now()
    const saveRuntime = () => writeFile(runtimePath, JSON.stringify(runtime), { mode: 0o600 })
    const request = (path: string, method: string, body?: unknown, authorized = true) => new Request(runtime.app.origin + path, {
        method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
            host: new URL(runtime.app.origin).host, origin: runtime.app.origin, 'Content-Type': 'application/json',
            ...(authorized ? { cookie: `rerun-desktop-session=${runtime.app.sessionToken}` } : {}),
        },
    })
    try {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        vi.stubEnv('RERUN_DESKTOP_RUNTIME_FILE', runtimePath)
        vi.stubEnv('RERUN_DESKTOP_DATA_DIR', root)
        vi.stubEnv('RERUN_DESKTOP_INSTALL_DIR', root)
        vi.stubEnv('RERUN_DESKTOP_WORKSPACE_ID', '1')
        vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', '42'.repeat(32))
        vi.spyOn(Date, 'now').mockImplementation(() => now)
        await saveRuntime()
        await mkdir(join(root, 'workspaces', '1', 'engine', 'agents', engineAgent, 'workspace'), { recursive: true })
        const db = await openDesktopDatabase(root)
        const agent = await createDesktopAgent(db, { engineAgentId: engineAgent, name: 'Fixture coworker' })
        const session = await createDesktopSession(db, { agentId: agent.id, engineSessionId: engineSession, title: 'Fixture chat' })
        const context = { params: Promise.resolve({ sessionId: session.id }) }
        const path = `/api/desktop/sessions/${session.id}`
        const server = { name: 'docs', url: resource, revision: '', displayName: 'Docs' }
        const guard = { runId: 'fixture-run', sourceMessageId: 'fixture-message', toolCallId: 'fixture-tool', fingerprint: 'fixture-fingerprint', server }
        const source = { agentId: agent.id, sessionId: session.id, ...guard }
        const enginePath = `/agents/${engineAgent}`
        const sent: unknown[] = [], toolProbe: string[] = []
        let mcpGranted = true
        vi.stubGlobal('fetch', vi.fn(async (input: URL | string, options?: RequestInit) => {
            const url = new URL(input)
            const body = options?.body ? JSON.parse(String(options.body)) : null
            const headers = new Headers(options?.headers)
            if (url.href === resource) {
                expect(headers.get('authorization')).toBe(`Bearer ${privateToken}`)
                toolProbe.push(body.method)
                if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
                const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26' }
                    : { tools: [{ name: 'search', inputSchema: { type: 'object' } }] }
                return Response.json({ jsonrpc: '2.0', id: body.id, result })
            }
            expect(url.origin).toBe(runtime.engine.origin)
            expect(headers.get('authorization')).toBe(`Bearer ${runtime.engine.apiKey}`)
            if (url.pathname === enginePath) return Response.json({
                id: engineAgent, config: { name: 'Fixture coworker', enabled: true, tools: { desktopToolGrants: { mcp: mcpGranted } } }, soul: '',
            })
            if (url.pathname === `${enginePath}/sessions/${engineSession}/mcp-sign-in-source`) {
                return Response.json({ agentId: engineAgent, sessionId: engineSession,
                    request: { guard, input: { name: server.name }, status: 'done' } })
            }
            if (url.pathname === `${enginePath}/chat`) {
                if (body.desktopQueuedTurn.replayOnly) return Response.json({ code: 'queued_turn_not_found' }, { status: 404 })
                sent.push(body)
                return new Response('data: [DONE]\n\n', { headers: {
                    'x-session-id': engineSession, 'x-run-id': body.desktopQueuedTurn.runId, 'content-type': 'text/event-stream',
                } })
            }
            throw new Error('Unexpected fixture transport request')
        }))
        transport.discovery.mockImplementation(async () => ({
            kind: 'device-code-rfc8628-v1', resource, issuer, clientId: 'fixture-public-client',
            deviceEndpoint: issuer + 'device', tokenEndpoint: issuer + 'token', verificationUri: issuer + 'verify',
        }))
        transport.device.mockImplementation(async (url: string, _signal: AbortSignal, form: URLSearchParams) => {
            if (url === issuer + 'device') return { status: 200, body: {
                device_code: privateDeviceCode, user_code: userCode, verification_uri: issuer + 'verify', expires_in: 120, interval: 5,
            } }
            expect(url).toBe(issuer + 'token')
            expect(form.get('device_code')).toBe(privateDeviceCode)
            return { status: 200, body: { access_token: privateToken, token_type: 'Bearer', expires_in: 3600 } }
        })
        const configured = await configureServer(request(`/api/desktop/coworkers/${agent.id}/mcp`, 'PUT', {
            name: server.name, url: resource, deviceClient: { clientId: 'fixture-public-client', verificationUri: issuer + 'verify' },
        }), { params: Promise.resolve({ agentId: agent.id }) })
        expect(configured.status).toBe(200)
        server.revision = (await configured.json())[0].revision

        const read = () => readSignIn(request(path + '/mcp-sign-in', 'GET'), context)
        const device = (action: string, fields = {}, authorized = true) => deviceSignIn(request(
            path + '/mcp-device-sign-in', 'POST', { action, source, ...fields }, authorized), context)
        const initial = await (await read()).json()
        expect(initial.oauth).toMatchObject({ state: 'idle', deviceAvailable: true })
        expect((await device('review-device-method', {}, false)).status).toBe(401)
        const proposed = await device('review-device-method')
        expect(proposed.status).toBe(200)
        const { review } = await proposed.json()
        const ids = { reviewId: review.reviewId, revision: review.revision }
        expect(await (await device('start-device-authorization', { ...ids, requestId: randomUUID() })).json())
            .toEqual({ attempt: { state: 'approval_required', authorization: null } })
        expect(transport.device).not.toHaveBeenCalled()
        const approved = await device('decide-device-method', { decision: { ...ids, operation: 'approve-device-method', decisionId: randomUUID() } })
        expect(await approved.json()).toMatchObject({ review: { state: 'approved' } })
        expect((await device('start-device-authorization', { ...ids, source: { ...source, runId: 'different-run' }, requestId: randomUUID() })).status).toBe(409)
        mcpGranted = false
        expect((await device('start-device-authorization', { ...ids, requestId: randomUUID() })).status).toBe(409)
        expect(transport.device).not.toHaveBeenCalled()
        mcpGranted = true

        const started = await device('start-device-authorization', { ...ids, requestId: randomUUID() })
        expect(started.headers.get('cache-control')).toBe('no-store')
        const waiting = await started.json()
        expect(waiting).toMatchObject({ attempt: { state: 'waiting', authorization: { userCode, verificationUri: issuer + 'verify' } } })
        expect(JSON.stringify(waiting)).not.toContain(privateDeviceCode)
        expect(transport.device).toHaveBeenCalledTimes(1)
        const browser = await browserSignIn(request(path + '/mcp-sign-in', 'POST', { action: 'connect', request: {
            source, operation: 'connect', requestId: initial.request.requestId, expectedRevision: initial.request.revision, attemptId: randomUUID(),
        } }), context)
        expect(await browser.json()).toMatchObject({ oauth: { state: 'error' } })

        const staleCookie = request(path + '/mcp-device-sign-in', 'POST', { action: 'read-device-authorization', source, ...ids })
        await shutdownDesktopRemoteMcp(runtime)
        await closeDesktopDatabase(root)
        runtime = { ...runtime, launchNonce: randomUUID(), app: { ...runtime.app, sessionToken: randomUUID() } }
        await saveRuntime()
        expect((await deviceSignIn(staleCookie, context)).status).toBe(401)
        const resumed = await device('read-device-authorization', ids)
        expect(await resumed.json()).toEqual({ authorization: waiting.attempt.authorization })
        expect(transport.device).toHaveBeenCalledTimes(1)
        now += 5001
        const completed = await device('check-device-authorization', { ...ids, requestId: randomUUID() })
        expect(await completed.json()).toEqual({ attempt: { state: 'connected', authorization: null } })
        expect(transport.device).toHaveBeenCalledTimes(2)
        expect(toolProbe).toEqual([])
        const current = await (await read()).json()
        expect(current.oauth.state).toBe('connected')
        const continued = await browserSignIn(request(path + '/mcp-sign-in', 'POST', { action: 'complete', request: {
            source, operation: 'connect', requestId: current.request.requestId, expectedRevision: current.request.revision, attemptId: randomUUID(),
        } }), context)
        expect(continued.status).toBe(200)
        expect(continued.headers.get('x-session-id')).toBe(session.id)
        expect(toolProbe).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
        expect(sent).toHaveLength(1)
        for (const privateValue of [privateToken, privateDeviceCode, userCode]) expect(JSON.stringify(sent)).not.toContain(privateValue)
        expect(await (await read()).json()).toMatchObject({ request: {
            requestId: initial.request.requestId,
            receipt: { accepted: true, outcome: 'connected', continuationRequestId: continued.headers.get('x-run-id') },
        } })
    } finally {
        try { await shutdownDesktopRemoteMcp(runtime) }
        finally {
            await closeDesktopDatabase(root)
            vi.unstubAllGlobals()
            vi.unstubAllEnvs()
            vi.restoreAllMocks()
            vi.resetAllMocks()
            await rm(root, { recursive: true, force: true })
        }
    }
})
