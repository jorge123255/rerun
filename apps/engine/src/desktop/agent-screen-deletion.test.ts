import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'

const root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-delete-screen-')))
process.env.RERUN_DATA_DIR = root
process.env.RERUN_DESKTOP_APP = '1'
process.env.RERUN_API_KEY = ''
process.env.RERUN_HUB_BASE_URL = ''
process.env.RERUN_DESKTOP_SECRET_KEY = '2'.repeat(64)

const docker = vi.hoisted(() => ({
    inspectContainer: vi.fn(async (): Promise<{ status: 'unreachable' | 'missing' }> => ({ status: 'unreachable' })),
    inspectVolume: vi.fn(async (): Promise<{ status: 'unreachable' | 'missing' }> => ({ status: 'unreachable' })),
    version: vi.fn(async () => ({ kind: 'ok' as const, os: 'linux', arch: 'arm64' })),
    image: vi.fn(async () => ({ kind: 'present' as const, architecture: 'arm64' })),
    createVolume: vi.fn(async () => { throw new Error('synthetic ambiguous volume creation') }),
}))
vi.mock('./isolated-screen/docker-cli.js', () => ({ createDockerCli: () => docker }))

const { createServer } = await import('../http/server.js')
const { migrate } = await import('../db/migrate.js')
const { bindIsolatedScreen } = await import('./isolated-screen/binding.js')
const { service } = await import('./isolated-screen/index.js')
const { agentDir } = await import('../config/paths.js')
const { knownUnusedScreen } = await import('./isolated-screen/ownership.js')
const app = createServer()

beforeAll(async () => {
    await migrate()
    bindIsolatedScreen({ launchNonce: 'test-launch', app: { origin: 'http://127.0.0.1:1' } })
})
beforeEach(() => vi.clearAllMocks())
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

async function coworker(name: string) {
    const response = await app.request('/agents', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: { name } }),
    })
    expect(response.status).toBe(201)
    return (await response.json() as { id: string }).id
}

test('deletes a newly created coworker that never allocated a screen with Docker offline', async () => {
    const id = await coworker('No screen')
    const deleted = await app.request(`/agents/${id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ deleted: id })
    expect(docker.inspectContainer).not.toHaveBeenCalled()
    expect(docker.inspectVolume).not.toHaveBeenCalled()
})

test('keeps deletion pending if an allocation could have created Docker resources', async () => {
    const id = await coworker('Possible screen')
    docker.inspectContainer.mockResolvedValueOnce({ status: 'missing' })
    docker.inspectVolume.mockResolvedValueOnce({ status: 'missing' }).mockResolvedValueOnce({ status: 'missing' })
    await expect(service().ensure({ engineAgentId: id, launchNonce: 'test-launch' }, AbortSignal.timeout(5000)))
        .rejects.toThrow('synthetic ambiguous volume creation')
    expect(docker.createVolume).toHaveBeenCalledTimes(1)
    expect(await knownUnusedScreen(id)).toBe(false)
    expect((await app.request(`/agents/${id}`, { method: 'DELETE' })).status).toBe(500)
    expect((await app.request(`/agents/${id}`)).status).toBe(200)

    docker.inspectContainer.mockResolvedValueOnce({ status: 'missing' })
    docker.inspectVolume.mockResolvedValueOnce({ status: 'missing' })
    expect((await app.request(`/agents/${id}`, { method: 'DELETE' })).status).toBe(200)
})

test('does not use another coworker’s copied unused marker as absence proof', async () => {
    const donor = await coworker('Marker donor')
    const recipient = await coworker('Marker recipient')
    const marker = '.desktop-screen-unused.json'
    await copyFile(join(agentDir(donor), marker), join(agentDir(recipient), marker))
    expect(await knownUnusedScreen(donor)).toBe(true)
    expect(await knownUnusedScreen(recipient)).toBe(false)
    expect((await app.request(`/agents/${recipient}`, { method: 'DELETE' })).status).toBe(500)
    expect(docker.inspectContainer).toHaveBeenCalledTimes(1)
})
