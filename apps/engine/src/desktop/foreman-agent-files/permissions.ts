import { Hono } from 'hono'
import { z } from 'zod'
import { FOREMAN_AGENT_ID, type AgentConfig } from '@rerun/contracts'
import { readAgentConfig } from '../../agents/loader.js'
import { writeAgentConfig } from '../../agents/config-write.js'
import { withAgentLock } from '../../agents/lock.js'
import { unloadAgent } from '../../agents/registry.js'
import { desktopApp } from '../policy.js'
import { assertDesktopRunAdmission } from '../workspace-admission.js'

export const foremanFileGrantsSchema = z.strictObject({ foremanAgentFilesRead: z.boolean(), foremanAgentFilesWrite: z.boolean(), delegate: z.boolean().optional(), callAgent: z.boolean().optional() })
export const foremanFilePermissionChangeSchema = z.strictObject({
    workspaceId: z.string().min(1).max(128), launchNonce: z.uuid(), expectedGrants: foremanFileGrantsSchema,
    id: z.enum(['foremanAgentFilesRead', 'foremanAgentFilesWrite', 'delegate', 'callAgent']), enabled: z.boolean(),
})
type Context = { workspaceId: string | number; launchNonce: string }
export type ForemanFilePermissionPorts = {
    current(): boolean
    lock<T>(work: () => Promise<T>): Promise<T>
    read(): Promise<AgentConfig>
    write(config: AgentConfig): Promise<void>
    admit(): void
}
const grantsOf = (config: AgentConfig) => ({
    foremanAgentFilesRead: config.tools.desktopToolGrants?.foremanAgentFilesRead === true,
    foremanAgentFilesWrite: config.tools.desktopToolGrants?.foremanAgentFilesWrite === true,
    delegate: config.tools.desktopToolGrants?.delegate === true,
    callAgent: config.tools.desktopToolGrants?.callAgent === true,
})
async function permissionBody(request: Request): Promise<string> {
    const reader = request.body?.getReader()
    if (!reader) throw new Error('Missing permission request.')
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    const chunks: Uint8Array[] = []
    let length = 0
    try {
        for (;;) {
            signal.throwIfAborted()
            const part = await reader.read()
            signal.throwIfAborted()
            if (part.done) break
            length += part.value.byteLength
            if (length > 2048) throw new RangeError('Permission request exceeds limit.')
            chunks.push(part.value)
        }
        return Buffer.concat(chunks).toString('utf8')
    } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}) }
}

/** Dedicated local-human endpoint. Generic managed-Foreman mutation remains forbidden. */
export function createForemanFilePermissionRoutes(context: Context | undefined, current: () => boolean, ports?: ForemanFilePermissionPorts) {
    const routes = new Hono()
    const authority: ForemanFilePermissionPorts = ports ?? {
        current: () => desktopApp() && current(),
        lock: work => withAgentLock(FOREMAN_AGENT_ID, work),
        read: () => readAgentConfig(FOREMAN_AGENT_ID),
        async write(config) { await writeAgentConfig(FOREMAN_AGENT_ID, config); unloadAgent(FOREMAN_AGENT_ID) },
        admit: assertDesktopRunAdmission,
    }
    const live = () => { if (!context || !authority.current()) throw new Error('Foreman permissions are unavailable for this launch.') }
    const read = async () => {
        live()
        const config = await authority.read()
        live()
        if (config.kind !== 'foreman' || !config.enabled) throw new Error('The managed Foreman is unavailable.')
        return config
    }
    const view = (config: AgentConfig) => ({ workspaceId: String(context!.workspaceId), launchNonce: context!.launchNonce, grants: grantsOf(config) })
    routes.get('/file-permissions', async c => {
        try { return c.json(view(await read()), 200, { 'cache-control': 'no-store' }) }
        catch { return c.json({ error: 'Foreman file permissions could not be read.' }, 409) }
    })
    routes.patch('/file-permissions', async c => {
        try {
            const raw = await permissionBody(c.req.raw)
            const input = foremanFilePermissionChangeSchema.parse(JSON.parse(raw))
            live()
            if (input.workspaceId !== String(context!.workspaceId) || input.launchNonce !== context!.launchNonce) return c.json({ error: 'The workspace or app launch changed.' }, 409)
            return await authority.lock(async () => {
                authority.admit()
                const config = await read(), before = grantsOf(config)
                if (before.foremanAgentFilesRead !== input.expectedGrants.foremanAgentFilesRead || before.foremanAgentFilesWrite !== input.expectedGrants.foremanAgentFilesWrite
                    || (input.id === 'delegate' || input.expectedGrants.delegate !== undefined) && before.delegate !== input.expectedGrants.delegate
                    || (input.id === 'callAgent' || input.expectedGrants.callAgent !== undefined) && before.callAgent !== input.expectedGrants.callAgent) return c.json({ error: 'Foreman permissions changed. Refresh before choosing again.' }, 409)
                c.req.raw.signal.throwIfAborted()
                authority.admit(); live()
                const next = { ...config, tools: { ...config.tools, desktopToolGrants: { ...config.tools.desktopToolGrants, [input.id]: input.enabled } } }
                await authority.write(next)
                live()
                return c.json(view(next), 200, { 'cache-control': 'no-store' })
            })
        } catch (error) {
            if (error instanceof RangeError) return c.json({ error: 'Permission request exceeds limit.' }, 413)
            // A lost response is reconciled by a read, never an automatic second mutation.
            return c.json({ error: 'The permission change was not acknowledged. Refresh to inspect its saved state.' }, 409)
        }
    })
    return routes
}
