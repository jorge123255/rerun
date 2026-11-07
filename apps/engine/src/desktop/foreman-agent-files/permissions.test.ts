import { expect, test } from 'vitest'
import { agentConfigSchema } from '../../agents/types.js'
import { createForemanFilePermissionRoutes, type ForemanFilePermissionPorts } from './permissions.js'

const context = { workspaceId: 1, launchNonce: '11111111-1111-4111-8111-111111111111' }
function fixture() {
    let config = agentConfigSchema.parse({ name: 'Foreman', kind: 'foreman' }), writes = 0
    let current = true
    const ports: ForemanFilePermissionPorts = {
        current: () => current, lock: work => work(), read: async () => config,
        write: async next => { config = next; writes += 1 }, admit: () => {},
    }
    const app = createForemanFilePermissionRoutes(context, () => true, ports)
    return { app, config: () => config, writes: () => writes, close: () => { current = false } }
}
const off = { foremanAgentFilesRead: false, foremanAgentFilesWrite: false }
const patch = (body: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('managed Foreman permissions default off, mutate only one explicit grant and require fresh launch/state', async () => {
    const f = fixture()
    expect(await (await f.app.request('/file-permissions')).json()).toMatchObject({ ...context, workspaceId: '1', grants: off })
    const body = { ...context, workspaceId: '1', expectedGrants: off, id: 'foremanAgentFilesRead', enabled: true }
    expect((await f.app.request('/file-permissions', patch(body))).status).toBe(200)
    expect(f.config().tools.desktopToolGrants).toMatchObject({ foremanAgentFilesRead: true })
    expect(f.config().tools.desktopToolGrants?.foremanAgentFilesWrite).not.toBe(true)
    expect((await f.app.request('/file-permissions', patch({ ...body, id: 'foremanAgentFilesWrite' }))).status).toBe(409)
    expect((await f.app.request('/file-permissions', patch({ ...body, workspaceId: '2' }))).status).toBe(409)
    expect((await f.app.request('/file-permissions', patch({ ...body, launchNonce: '22222222-2222-4222-8222-222222222222' }))).status).toBe(409)
    expect((await f.app.request('/file-permissions', patch({ ...body, id: 'mcp' }))).status).toBe(409)
    expect(f.writes()).toBe(1)
    f.close()
    expect((await f.app.request('/file-permissions')).status).toBe(409)
})
