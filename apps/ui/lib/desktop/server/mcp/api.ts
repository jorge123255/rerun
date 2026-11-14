import 'server-only'
import { authenticateDesktopRequest, DesktopHttpError } from '../auth'
import { abortable, boundedText, type McpAccess, remoteMcpRuntime } from './remote'
import type { RemoteMcpStore } from './store'
import { deviceOAuthClient, discoverDeviceOAuth } from './oauth-network'
import { endpoint, serverName } from './model'

export const MCP_ADMISSION_TIMEOUT_MS = 10_000
async function admit(request:Request, agent:string, access:McpAccess) {
    const deadline=new AbortController()
    const signal=AbortSignal.any([request.signal,deadline.signal])
    const timer=setTimeout(()=>deadline.abort(),MCP_ADMISSION_TIMEOUT_MS)
    try {
        signal.throwIfAborted()
        await abortable(access(agent),signal)
        signal.throwIfAborted()
    } finally {clearTimeout(timer)}
}

// Root binds authenticated route handlers to its database/key and authoritative grant reader.
export function remoteMcpApi(store: RemoteMcpStore, runtime: ReturnType<typeof remoteMcpRuntime>, access: McpAccess, discover = discoverDeviceOAuth) {
    return async (request: Request, agent: string): Promise<Response> => {
        try {
            await authenticateDesktopRequest(request)
            // An extant coworker is required even to manage configuration. Disabled coworkers may edit.
            await admit(request,agent,access)
            request.signal.throwIfAborted()
            let result: unknown
            if (request.method === 'GET') result = await store.listSettings(agent)
            else {
                const body = JSON.parse(await boundedText(new Response(request.body),AbortSignal.any([request.signal,AbortSignal.timeout(10000)]),16384))
                request.signal.throwIfAborted()
                if (!body || typeof body !== 'object' || typeof body.name !== 'string') throw new DesktopHttpError(400,'Invalid MCP request')
                if (request.method === 'PUT') {
                    if (typeof body.url !== 'string' || (body.bearer !== undefined && typeof body.bearer !== 'string') || (body.revision !== undefined && typeof body.revision !== 'string')) throw new DesktopHttpError(400,'Invalid MCP configuration')
                    const name = serverName(body.name)
                    const deviceClient = body.deviceClient == null ? body.deviceClient as null | undefined : deviceOAuthClient(body.deviceClient)
                    if (deviceClient) {
                        if (body.bearer) throw new DesktopHttpError(400,'Device sign-in needs a server without a bearer')
                        const signal = AbortSignal.any([request.signal,AbortSignal.timeout(20_000)])
                        if (body.revision !== undefined) {
                            const current = (await abortable(store.list(agent),signal)).find(row => row.name === name)
                            if (!current || current.revision !== body.revision || current.transport !== 'http') throw new DesktopHttpError(409,'MCP server changed')
                            if (current.hasBearer && body.bearer !== '') throw new DesktopHttpError(400,'Clear the configured bearer before device sign-in')
                        }
                        await abortable(discover(endpoint(body.url),deviceClient,signal),signal)
                        signal.throwIfAborted()
                    }
                    await store.save(agent,{name,url:body.url,bearer:body.bearer,revision:body.revision,deviceClient},request.signal)
                    result = await store.listSettings(agent)
                } else if (request.method === 'DELETE') {
                    if (typeof body.revision !== 'string') throw new DesktopHttpError(400,'Revision required')
                    await store.remove(agent,body.name,body.revision)
                    result = await store.listSettings(agent)
                } else if (request.method === 'POST') {
                    if (typeof body.revision !== 'string') throw new DesktopHttpError(400,'Revision required')
                    if (body.action === 'disconnect') {
                        const current=runtime.watch(agent,body.name)
                        const signal=AbortSignal.any([request.signal,AbortSignal.timeout(MCP_ADMISSION_TIMEOUT_MS)])
                        const saved=await abortable(store.read(agent,body.name),signal)
                        signal.throwIfAborted();current()
                        if(saved.revision!==body.revision)throw new DesktopHttpError(409,'MCP server changed')
                        // No await between the final identity/generation check and invalidation.
                        runtime.disconnect(agent,body.name);result={disconnected:true}
                    }
                    else if (body.action === 'probe') {
                        const current=runtime.watch(agent,body.name)
                        result = await runtime.probe(agent,body.name,body.revision,request.signal)
                        await runtime.validate(agent,body.name,body.revision,request.signal)
                        current()
                    }
                    else throw new DesktopHttpError(400,'Unknown MCP action')
                } else throw new DesktopHttpError(405,'Method not allowed')
            }
            return Response.json(result,{headers:{'Cache-Control':'no-store'}})
        } catch (error) {
            // Never serialize remote error text or validation inputs: either may contain credentials.
            return Response.json({error:'MCP request failed; reload configuration and check permissions'}, {status:error instanceof DesktopHttpError ? error.status : 400,headers:{'Cache-Control':'no-store'}})
        }
    }
}
