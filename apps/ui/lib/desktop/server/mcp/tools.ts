import 'server-only'
import { abortable, type remoteMcpRuntime } from './remote'
import type { RemoteMcpStore } from './store'

/** Adapter-neutral definitions for root's local Codex dynamic-tool bridge. Never send credentials. */
export async function remoteMcpTools(agent: string, store: RemoteMcpStore, runtime: ReturnType<typeof remoteMcpRuntime>, signal: AbortSignal) {
    const definitions = []
    const currentCatalog: (()=>void)[] = []
    const validations: (()=>Promise<void>)[] = []
    const names = new Set<string>()
    const servers = await abortable(store.list(agent),AbortSignal.any([signal,AbortSignal.timeout(20_000)]))
    if (servers.length > 16) throw new Error('Too many MCP servers; limit is 16')
    for (const server of servers) {
        if (server.transport === 'sse') continue
        const current=runtime.watch(agent,server.name)
        currentCatalog.push(current)
        const validate = async () => {
            signal.throwIfAborted()
            current()
            await runtime.validate(agent, server.name, server.revision, signal)
            signal.throwIfAborted()
            current()
        }
        validations.push(validate)
        const listed = await runtime.probe(agent, server.name, server.revision, signal).catch(async () => {
            // A server that needs sign-in must leave the chat's sign-in tool reachable.
            await validate()
            return { tools: [] }
        })
        for (const tool of listed.tools ?? []) {
            const name = `${server.name}_${tool.name}`
            if (names.has(name)) throw new Error('Conflicting MCP tool names; rename a server')
            if (name.length > 128 || names.size >= 256) throw new Error('MCP catalog exceeds limit')
            names.add(name)
            definitions.push({ name, description:tool.description ?? tool.name, inputSchema:tool.inputSchema,
                execute:async (args:Record<string,unknown>, stop:AbortSignal = signal) => {
                    current()
                    const combined=AbortSignal.any([signal,stop])
                    combined.throwIfAborted()
                    const output = await runtime.call(agent,server.name,server.revision,tool.name,args,combined)
                    await runtime.validate(agent,server.name,server.revision,combined)
                    combined.throwIfAborted(); current()
                    return { source:'remote_mcp', untrusted:true, result:output.result }
                } })
        }
    }
    await Promise.all(validations.map(check=>check()))
    for (const current of currentCatalog) current()
    return definitions
}
