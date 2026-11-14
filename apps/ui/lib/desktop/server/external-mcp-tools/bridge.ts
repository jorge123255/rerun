import 'server-only'
import { externalMcpBridgeRequestSchema, externalMcpToolRegistrationSchema, externalMcpToolResultSchema } from '@rerun/contracts'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'
import { readDesktopJson } from '../request-json'
import type { DesktopRuntime } from '../runtime'
import { recheckDesktopExternalMcp } from '../external-mcp-authority/client'
import { createLocalExternalMcpTools } from './factory'
import type { ExternalMcpServicesAuthority } from './operations'
import { openDesktopDatabase } from '../database'
import { admitDesktopImportCall, desktopImportToolNames, readDesktopImportKey } from './import-keys'

export function createDesktopExternalMcpToolsHandler(options: {
    services?: (runtime: DesktopRuntime) => Promise<ExternalMcpServicesAuthority>
} = {}) {
    return async (request: Request): Promise<Response> => {
        try {
            if (request.method !== 'POST') throw new DesktopHttpError(405, 'Method not allowed.')
            const runtime = await authenticateDesktopEngineRequest(request)
            const input = externalMcpBridgeRequestSchema.parse(await readDesktopJson(request, 200_000))
            const principal = input.action === 'list' ? input.principal : input.context.principal
            if (principal.workspaceId !== runtime.workspaceId || principal.runtimeWorkspaceId !== runtime.workspaceId
                || principal.launchNonce !== runtime.launchNonce || runtime.installId && principal.installId !== runtime.installId) {
                throw new DesktopHttpError(409, 'External MCP runtime changed.')
            }
            const signal = AbortSignal.any([request.signal, AbortSignal.timeout(input.action === 'list' ? 15_000 : 600_000)])
            const recheck = (check: Parameters<typeof recheckDesktopExternalMcp>[1]) => recheckDesktopExternalMcp(runtime, check, signal)
            const { keyId,workspaceId,keyRevision,installId,launchNonce,scopes } = principal
            const live = await recheck({ keyId,workspaceId,keyRevision,installId,launchNonce,scopes, requestId: input.action === 'call' ? input.context.requestId : crypto.randomUUID() })
            if (!live.ok) throw new DesktopHttpError(409, 'External MCP authority changed.')
            const services = options.services ? await options.services(runtime) : undefined
            signal.throwIfAborted()
            const dispatch = createLocalExternalMcpTools({ recheck, services })
            // A key made for an import sees and reaches only the import tools, and writes only to the
            // one coworker it creates. Any other key passes through unchanged.
            const db = await openDesktopDatabase(runtime.dataRoot)
            let result: unknown
            if (input.action === 'list') {
                const tools = externalMcpToolRegistrationSchema.array().parse(await dispatch.listTools(principal))
                result = await readDesktopImportKey(db, keyId) ? tools.filter(tool => desktopImportToolNames.has(tool.name)) : tools
            } else {
                let admitted: Awaited<ReturnType<typeof admitDesktopImportCall>> = null, refused: string | null = null
                try {
                    admitted = await admitDesktopImportCall(db, keyId, input.context.tool, input.context.arguments as Record<string, unknown>, input.context.requestId)
                } catch (error) {
                    // What an import key may not do is said in words the calling agent can act on.
                    // Nothing was run, so this is an answer, not an uncertain outcome.
                    refused = error instanceof Error && error.message ? error.message.slice(0, 400) : 'This import key cannot make that call.'
                }
                if (refused) result = externalMcpToolResultSchema.parse({ content: [{ type: 'text', text: refused }], isError: true })
                else try {
                    const called = externalMcpToolResultSchema.parse(await dispatch.callTool(input.context, signal))
                    const created = (called.structuredContent as { agent?: { id?: unknown } } | undefined)?.agent?.id
                    await admitted?.settle(typeof created === 'string' ? created : null)
                    result = called
                } catch (error) {
                    await admitted?.settle(null)
                    throw error
                }
            }
            signal.throwIfAborted()
            return Response.json(result, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            return Response.json({ error: 'The external MCP request could not be confirmed.' }, { status: error instanceof DesktopHttpError ? error.status : 409, headers: { 'cache-control': 'no-store' } })
        }
    }
}
