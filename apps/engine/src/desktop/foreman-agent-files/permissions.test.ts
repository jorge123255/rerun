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

test('Foreman delegation requires an explicit current opt-in independent of file grants', async () => {
    const f = fixture()
    const body = { ...context, workspaceId: '1', expectedGrants: off, id: 'delegate', enabled: true }
    expect((await f.app.request('/file-permissions', patch(body))).status).toBe(409)
    const enabled = await f.app.request('/file-permissions', patch({ ...body, expectedGrants: { ...off, delegate: false } }))
    expect(enabled.status).toBe(200)
    expect(await enabled.json()).toMatchObject({ grants: { ...off, delegate: true } })
    expect(f.config().tools.desktopToolGrants?.delegate).toBe(true)
    const disabled = await f.app.request('/file-permissions', patch({ ...body, enabled: false, expectedGrants: { ...off, delegate: true } }))
    expect(disabled.status).toBe(200)
    expect(f.config().tools.desktopToolGrants?.delegate).toBe(false)
})

test('action approval requests default off and change only with explicit fresh permission state', async () => {
    const f = fixture()
    const body = { ...context, workspaceId: '1', expectedGrants: off, id: 'requestApproval', enabled: true }
    expect(await (await f.app.request('/file-permissions')).json()).toMatchObject({ grants: { ...off, requestApproval: false } })
    expect((await f.app.request('/file-permissions', patch(body))).status).toBe(409)
    expect((await f.app.request('/file-permissions', patch({ ...body, expectedGrants: { ...off, requestApproval: false } }))).status).toBe(200)
    expect(f.config().tools.desktopToolGrants).toEqual({ requestApproval: true })
    expect((await f.app.request('/file-permissions', patch({ ...body, enabled: false, expectedGrants: { ...off, requestApproval: true } }))).status).toBe(200)
    expect(f.config().tools.desktopToolGrants).toEqual({ requestApproval: false })
})

test('workspace metadata is an independent opt-in and requires the exact prior grant', async () => {
    const f = fixture()
    const body = { ...context, workspaceId: '1', expectedGrants: off, id: 'foremanWorkspaceRead', enabled: true }
    expect(await (await f.app.request('/file-permissions')).json()).toMatchObject({ grants: { ...off, foremanWorkspaceRead: false } })
    expect((await f.app.request('/file-permissions', patch(body))).status).toBe(409)
    const enabled = await f.app.request('/file-permissions', patch({ ...body, expectedGrants: { ...off, foremanWorkspaceRead: false } }))
    expect(enabled.status).toBe(200)
    expect(f.config().tools.desktopToolGrants).toEqual({ foremanWorkspaceRead: true })
    expect((await f.app.request('/file-permissions', patch({ ...body, enabled: false, expectedGrants: { ...off, foremanWorkspaceRead: false } }))).status).toBe(409)
    expect((await f.app.request('/file-permissions', patch({ ...body, enabled: false, expectedGrants: { ...off, foremanWorkspaceRead: true } }))).status).toBe(200)
    expect(f.config().tools.desktopToolGrants).toEqual({ foremanWorkspaceRead: false })
})
