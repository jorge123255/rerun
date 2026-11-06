import 'server-only'

import { z } from 'zod'
import { desktopClaudePlanAttemptActionSchema, desktopClaudePlanCompleteInputSchema, type DesktopClaudePlanOAuth, type DesktopClaudePlanAttemptStore, type DesktopClaudePlanChatStore, type DesktopClaudePlanCredentialCustody } from '@rerun/contracts'
import { authenticateDesktopRequest, DesktopHttpError } from '../auth'
import { abortable, boundedText } from '../mcp/remote'
import type { DesktopRuntime } from '../runtime'
import { createDesktopClaudePlanServer } from './service'

export function desktopClaudePlanHttp(runtime: DesktopRuntime, ports: { oauth: DesktopClaudePlanOAuth; custody: DesktopClaudePlanCredentialCustody; outcomes: DesktopClaudePlanAttemptStore; chats: DesktopClaudePlanChatStore }) {
    const server = createDesktopClaudePlanServer(runtime, ports)
    return async (request: Request, agentId: string): Promise<Response> => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        try {
            await abortable(authenticateDesktopRequest(request), signal)
            if (request.method === 'GET') {
                const operationId = new URL(request.url).searchParams.get('operationId')
                if (operationId) return Response.json({ chat: await server.chat(agentId, operationId) }, { headers: { 'cache-control': 'no-store' } })
                const attemptId = new URL(request.url).searchParams.get('attemptId')
                if (!attemptId) throw new DesktopHttpError(400, 'Choose a Claude sign-in attempt.')
                return Response.json({ attempt: await server.status(agentId, attemptId) }, { headers: { 'cache-control': 'no-store' } })
            }
            if (request.method !== 'POST') throw new DesktopHttpError(405, 'Method not allowed')
            const body = JSON.parse(await boundedText(new Response(request.body), signal, 16_384)) as { operation?: unknown }
            if (body.operation === 'start') return Response.json({ attempt: await server.start(agentId) }, { headers: { 'cache-control': 'no-store' } })
            if (body.operation === 'complete') return Response.json({ attempt: await server.complete(agentId, desktopClaudePlanCompleteInputSchema.parse(body), signal) }, { headers: { 'cache-control': 'no-store' } })
            if (body.operation === 'cancel' || body.operation === 'disconnect') return Response.json({ attempt: body.operation === 'cancel' ? await server.cancel(agentId, desktopClaudePlanAttemptActionSchema.parse(body)) : await server.disconnect(agentId, desktopClaudePlanAttemptActionSchema.parse(body)) }, { headers: { 'cache-control': 'no-store' } })
            throw new DesktopHttpError(400, 'Unknown Claude plan operation')
        } catch (error) {
            const status = error instanceof DesktopHttpError ? error.status : 400
            const message = error instanceof Error ? error.message.slice(0, 500) : 'Claude plan operation failed.'
            return Response.json({ error: message }, { status, headers: { 'cache-control': 'no-store' } })
        }
    }
}
