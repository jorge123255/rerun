import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const location = vi.hoisted(() => ({ root: '' }))
vi.mock('../config/paths.js', () => ({
    configPath: () => join(location.root, 'config.json'), soulPath: () => join(location.root, 'SOUL.md'), workspaceDir: () => join(location.root, 'workspace'),
}))
vi.mock('./registry.js', () => ({ unloadAgent: vi.fn() }))
import { ensureForeman } from './foreman.js'

beforeEach(async () => { location.root = await realpath(await mkdtemp(join(tmpdir(), 'foreman-grant-boot-'))) })
afterEach(async () => { await rm(location.root, { recursive: true, force: true }) })
const read = async () => JSON.parse(await readFile(join(location.root, 'config.json'), 'utf8'))

test('first boot defaults both file permissions off and later boots preserve each explicit choice', async () => {
    await ensureForeman()
    const config = await read()
    expect(config.tools.desktopToolGrants).toMatchObject({ foremanAgentFilesRead: false, foremanAgentFilesWrite: false })
    await writeFile(join(location.root, 'config.json'), JSON.stringify({ ...config, tools: { ...config.tools, desktopToolGrants: { foremanAgentFilesRead: true, foremanAgentFilesWrite: false, mcp: true } } }))
    await ensureForeman()
    const restarted = await read()
    expect(restarted.tools.desktopToolGrants).toEqual({ foremanAgentFilesRead: true, foremanAgentFilesWrite: false })
    expect(restarted.kind).toBe('foreman')
    expect(restarted.selfImprovement.enabled).toBe(false)
})
