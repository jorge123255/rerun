import 'server-only'
import { endpoint, type RemoteTool } from './model'
import type { RemoteMcpStore } from './store'

/** Race uncancellable local reads; handlers observe late resolution/rejection without publishing it. */
export function abortable<T>(work:Promise<T>, signal:AbortSignal):Promise<T> {
    return new Promise((resolve,reject)=>{
        const cancel=()=>reject(new Error('MCP operation cancelled or timed out'))
        signal.addEventListener('abort',cancel,{once:true})
        work.then(value=>{signal.removeEventListener('abort',cancel);if(signal.aborted)cancel();else resolve(value)},error=>{signal.removeEventListener('abort',cancel);reject(error)})
        if(signal.aborted)cancel()
    })
}
export type McpAccess = (agent: string) => Promise<{ enabled: boolean; granted: boolean }>
const LIMIT = 1024 * 1024
export async function boundedText(response: Response, signal: AbortSignal, limit = LIMIT, replyId?: number): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return ''
    const chunks: Uint8Array[] = []; let bytes = 0
    const stop = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', stop, { once:true })
    try {
        signal.throwIfAborted()
        while (true) {
            const chunk = await abortable(reader.read(),signal); signal.throwIfAborted()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > limit) throw new Error('MCP response exceeds limit')
            chunks.push(chunk.value)
            if (replyId !== undefined) {
                const partial = Buffer.concat(chunks).toString('utf8')
                const frames = partial.split(/\r?\n\r?\n/); frames.pop()
                if (frames.some(frame => {
                    const data = frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')
                    try { const value=JSON.parse(data); return value.jsonrpc==='2.0' && value.id===replyId } catch { return false }
                })) return frames.join('\n\n')
            }
        }
        return Buffer.concat(chunks).toString('utf8')
    } finally { signal.removeEventListener('abort',stop); await abortable(reader.cancel(),AbortSignal.timeout(1000)).catch(() => {}) }
}
export function decodeReply(text: string, mime: string, id: number): Record<string, any> {
    const messages = mime === 'application/json' ? [JSON.parse(text)] : text.split(/\r?\n\r?\n/).filter(Boolean).flatMap(frame => {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        return data ? [JSON.parse(data)] : []
    })
    const reply = messages.find(m => m.jsonrpc === '2.0' && m.id === id)
    if (!reply || reply.error || !reply.result || typeof reply.result !== 'object') throw new Error('MCP protocol request failed')
    return reply.result
}
export function remoteMcpRuntime(store: RemoteMcpStore, access: McpAccess, network: typeof fetch = fetch) {
    const lifecycle = store.lifecycle
    const disconnect = lifecycle.disconnect
    async function operate(agent: string, name: string, revision: string, call?: { name:string; arguments:Record<string,unknown> }, stop?: AbortSignal) {
        const controller = new AbortController(), signal = controller.signal
        const ticket = lifecycle.admit(agent,name,controller)
        let publish = async () => { ticket.assertCurrent() }
        try {
        const timer = setTimeout(() => controller.abort(), call ? 120_000 : 20_000)
        const cancel = () => controller.abort()
        stop?.addEventListener('abort',cancel,{once:true}); if (stop?.aborted) cancel()
        let bearer = '', session = '', id = 0, configuredUrl = ''
        const execute = async () => {
        try {
            const first = await abortable(store.read(agent,name),signal); bearer = first.bearer
            const url = endpoint(first.url); configuredUrl = url
            async function guard() {
                ticket.assertCurrent()
                const [permission,current] = await abortable(Promise.all([access(agent),store.read(agent,name)]),signal)
                ticket.assertCurrent()
                if (!permission.enabled || !permission.granted || current.revision !== revision || current.url !== url || current.bearer !== bearer) throw new Error('MCP permission or server changed')
            }
            publish = guard
            async function rpc(method: string, params: unknown, notification = false) {
                await guard()
                ticket.assertCurrent()
                const requestId = ++id
                const body = JSON.stringify({jsonrpc:'2.0',...(notification ? {} : {id:requestId}),method,params})
                if (Buffer.byteLength(body) > 65536) throw new Error('MCP request exceeds limit')
                const response = await network(url,{method:'POST', redirect:'manual',credentials:'omit', signal, headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26',...(bearer ? {Authorization:`Bearer ${bearer}`} : {}),...(session ? {'Mcp-Session-Id':session} : {})},body})
                if (!response.ok) { if(response.body)await abortable(response.body.cancel(),signal); throw new Error('MCP HTTP request failed') }
                const nextSession = response.headers.get('mcp-session-id')
                if (nextSession) { if (!/^[\x21-\x7e]{1,1024}$/.test(nextSession)) throw new Error('Invalid MCP session'); session = nextSession }
                if (notification && response.status === 202) { if(response.body)await abortable(response.body.cancel(),signal); await guard(); return {} }
                const mime = response.headers.get('content-type')?.split(';')[0].trim()
                if (mime !== 'application/json' && mime !== 'text/event-stream') { if(response.body)await abortable(response.body.cancel(),signal); throw new Error('Unsupported MCP response') }
                const raw = await boundedText(response,signal,LIMIT,mime === 'text/event-stream' ? requestId : undefined)
                // A malicious server can echo Authorization in any field, including tool schemas.
                const decoded = decodeReply(raw,mime,requestId)
                function redact(value: any): any {
                    if (typeof value === 'string') return bearer ? value.split(bearer).join('[REDACTED]') : value
                    if (Array.isArray(value)) return value.map(redact)
                    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[bearer ? k.split(bearer).join('[REDACTED]') : k,redact(v)]))
                    return value
                }
                await guard()
                return redact(decoded) as Record<string,any>
            }
            const init = await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'rerun-desktop',version:'1.0.0'}})
            if (init.protocolVersion !== '2025-03-26') throw new Error('Unsupported MCP protocol version')
            await rpc('notifications/initialized',{},true)
            const tools: RemoteTool[] = []; let cursor: string | undefined
            for (let page=0; page<8; page++) {
                const result = await rpc('tools/list',cursor ? {cursor} : {})
                if (!Array.isArray(result.tools)) throw new Error('Invalid tool list')
                for (const t of result.tools) {
                    if (!t || typeof t.name !== 'string' || !/^[\w.-]{1,128}$/.test(t.name) || !t.inputSchema || t.inputSchema.type !== 'object' || tools.some(x=>x.name===t.name)) throw new Error('Invalid MCP tool schema')
                    tools.push({name:t.name,description:typeof t.description==='string' ? t.description.slice(0,8000) : undefined,inputSchema:t.inputSchema})
                }
                if (tools.length > 256 || Buffer.byteLength(JSON.stringify(tools)) > LIMIT) throw new Error('MCP tool list exceeds limit')
                cursor = result.nextCursor
                if (!cursor) break
                if (typeof cursor !== 'string' || cursor.length > 4096 || page === 7) throw new Error('MCP pagination exceeds limit')
            }
            if (!call) return {tools}
            if (!tools.some(t=>t.name===call.name)) throw new Error('MCP tool unavailable')
            const result = await rpc('tools/call',call)
            if (!Array.isArray(result.content)) throw new Error('Invalid MCP tool result')
            // Preserve isError and structuredContent. Tool content is data, never instructions.
            return {result}
        } catch {
            throw new Error(signal.aborted ? 'MCP operation cancelled or timed out' : 'MCP operation failed; check permission, configuration and server')
        } finally {
            // Delete a server session only while its configured identity and grant still match.
            // Use a separate short deadline so an aborted run does not strand session state.
            if (session && configuredUrl && !signal.aborted) {
                const cleanupSignal=AbortSignal.any([signal,AbortSignal.timeout(1000)])
                try {
                    const [permission,current] = await abortable(Promise.all([access(agent),store.read(agent,name)]),cleanupSignal)
                    ticket.assertCurrent()
                    if (permission.enabled && permission.granted && current.revision === revision && current.url === configuredUrl && current.bearer === bearer) {
                        const closed = await abortable(network(configuredUrl,{method:'DELETE',redirect:'manual',credentials:'omit',signal:cleanupSignal,headers:{'Mcp-Session-Id':session,'MCP-Protocol-Version':'2025-03-26',...(bearer ? {Authorization:`Bearer ${bearer}`} : {})}}),cleanupSignal)
                        if(closed.body)await abortable(closed.body.cancel(),cleanupSignal)
                    }
                } catch { /* Never log server errors or credentials. */ }
            }
            session = ''
        }
        }
        try {
            const output = await execute()
            // Cleanup can await; validate again AFTER it and before exposing any result.
            await publish()
            ticket.assertCurrent()
            return output
        } finally {
            controller.abort(); clearTimeout(timer); stop?.removeEventListener('abort',cancel)
            bearer = ''
        }
        } finally { ticket.release() }
    }
    async function validate(agent:string,name:string,revision:string,signal:AbortSignal) {
        signal=AbortSignal.any([signal,AbortSignal.timeout(20_000)])
        const current = lifecycle.watch(agent,name)
        signal.throwIfAborted(); current()
        const [permission,server] = await abortable(Promise.all([access(agent),store.read(agent,name)]),signal)
        signal.throwIfAborted(); current()
        if (!permission.enabled || !permission.granted || server.revision!==revision) throw new Error('MCP capability unavailable')
    }
    return { disconnect, validate, watch:lifecycle.watch, probe:(agent:string,name:string,revision:string,signal?:AbortSignal)=>operate(agent,name,revision,undefined,signal),
        call:(agent:string,name:string,revision:string,tool:string,args:Record<string,unknown>,signal?:AbortSignal)=>operate(agent,name,revision,{name:tool,arguments:args},signal) }
}
