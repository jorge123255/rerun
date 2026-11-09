import { Hono } from 'hono'
import { withAgentLock } from '../../agents/lock.js'
import { getAgent } from '../../agents/registry.js'
import { dataDir } from '../../config/paths.js'
import { beginDesktopAgentWork } from '../agent-lifecycle.js'
import { desktopApp } from '../policy.js'
import { assertDesktopRunAdmission } from '../workspace-admission.js'
import { captureScopedPrivateDatabase, privateDatabaseCaptureIdentity } from './scoped.js'

/** Local UI uses this authenticated engine seam so the worker stays next to compiled engine assets. */
export function createPrivateDatabaseShareRoutes(workspaceId: number) {
    const routes = new Hono()
    routes.post('/capture', async c => {
        if (!desktopApp()) return c.json({ error: 'Private database capture is unavailable.' }, 404)
        try {
            const text = await c.req.text()
            if (Buffer.byteLength(text) > 4096) return c.json({ error: 'Private database capture input is too large.' }, 413)
            const input = privateDatabaseCaptureIdentity.parse(JSON.parse(text))
            if (input.workspaceId !== workspaceId) return c.json({ error: 'Workspace not found.' }, 404)
            return await withAgentLock(input.engineAgentId, async () => {
                const assertCurrent = async () => {
                    c.req.raw.signal.throwIfAborted()
                    assertDesktopRunAdmission()
                    const agent = await getAgent(input.engineAgentId)
                    if (agent.id !== input.engineAgentId || agent.config.kind === 'foreman' || agent.config.ephemeral) throw new Error('Coworker identity changed.')
                }
                const release = beginDesktopAgentWork(input.engineAgentId)
                try {
                    const pkg = await captureScopedPrivateDatabase({ ...input, engineRoot: dataDir(), signal: c.req.raw.signal, assertCurrent })
                    return c.json(pkg)
                } finally { release() }
            })
        } catch {
            return c.json({ error: 'This private database cannot be safely included.' }, 409)
        }
    })
    return routes
}
