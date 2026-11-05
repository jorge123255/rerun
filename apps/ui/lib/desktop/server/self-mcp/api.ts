import 'server-only'
import {
    selfMcpProposeRequestSchema,
    selfMcpRequestSchema,
    type SelfMcpProposeResult,
} from '@rerun/contracts'
import { authenticateDesktopEngineRequest, authenticateDesktopRequest, DesktopHttpError } from '../auth'
import { boundedText } from '../mcp/remote'
import { getDesktopSelfMcpService, type SelfMcpService } from './service'
import { SelfMcpProposalNotFoundError, SelfMcpStaleProposalError } from './decision'

const MANAGEMENT_BODY_LIMIT = 16_384
const BRIDGE_BODY_LIMIT = 96_000

async function readJson(request: Request, limit: number): Promise<unknown> {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
    return JSON.parse(await boundedText(new Response(request.body), signal, limit))
}

async function management(service: SelfMcpService, request: Request, agentId: string): Promise<Response> {
    const body = selfMcpRequestSchema.parse(await readJson(request, MANAGEMENT_BODY_LIMIT))
    let result: unknown
    if (body.action === 'list') result = { proposals: await service.list(agentId) }
    else if (body.action === 'review') result = await service.review(agentId, body.proposalId)
    else if (body.action === 'decide') result = await service.decide(agentId, body.decision)
    else result = await service.dismiss(agentId, body.proposalId, body.expectedProposalRevision)
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
}

// Session-authenticated management API, mounted at /api/desktop/agents/[agentId]/self-mcp.
export async function handleDesktopSelfMcp(request: Request, agentId: string): Promise<Response> {
    try {
        await authenticateDesktopRequest(request)
        return await management(getDesktopSelfMcpService(), request, agentId)
    } catch (error) {
        const status = error instanceof DesktopHttpError ? error.status
            : error instanceof SelfMcpProposalNotFoundError ? 404
            : error instanceof SelfMcpStaleProposalError ? 409
            : 400
        const message = error instanceof DesktopHttpError || error instanceof SelfMcpProposalNotFoundError || error instanceof SelfMcpStaleProposalError
            ? error.message
            : 'Self-MCP review is unavailable.'
        return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } })
    }
}

// Engine-authenticated propose bridge, mounted at /api/desktop/internal/self-mcp. Only the
// engine's mcp_register tool reaches it; the human management API is a separate route.
export async function handleDesktopSelfMcpBridge(request: Request): Promise<Response> {
    try {
        await authenticateDesktopEngineRequest(request)
        const body = selfMcpProposeRequestSchema.parse(await readJson(request, BRIDGE_BODY_LIMIT))
        const service = getDesktopSelfMcpService()
        const result: SelfMcpProposeResult = await service.propose({ identity: body.identity, fingerprint: body.fingerprint, input: body.input })
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
        return Response.json({ error: 'MCP proposal failed. Check this coworker’s permission and connection.' },
            { status: error instanceof DesktopHttpError ? error.status : 400, headers: { 'Cache-Control': 'no-store' } })
    }
}
