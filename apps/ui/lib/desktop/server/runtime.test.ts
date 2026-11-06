import { mkdtemp, chmod, rm, writeFile, mkdir, realpath, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readDesktopRuntime, desktopEngineParts, desktopEngineRoot } from './runtime'
import { GET as desktopHealth } from '@/app/api/desktop/health/route'

const originalEnv = { ...process.env }
let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-runtime-'))
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_DATA_DIR = root
    process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
    delete process.env.RERUN_DESKTOP_WORKSPACE_ID
    delete process.env.RERUN_DESKTOP_INSTALL_DIR
    delete process.env.RERUN_DESKTOP_ENGINE_ROOT
    delete process.env.RERUN_DESKTOP_ADMISSIONS_FROZEN
    delete process.env.RERUN_DESKTOP_WORKSPACE_NAME
    delete process.env.RERUN_DESKTOP_WORKSPACE_ICON
})

afterEach(async () => {
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

async function writeRuntime(overrides: Record<string, unknown> = {}) {
    const runtime = {
        protocolVersion: 1,
        launchNonce: 'launch-test',
        buildId: 'build-test',
        workspaceId: 1,
        dataRoot: root,
        app: { origin: 'http://127.0.0.1:3100', sessionToken: 'a'.repeat(48) },
        engine: { origin: 'http://127.0.0.1:3101', apiKey: 'engine-test-key' },
        ...overrides,
    }
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    return runtime
}

describe('readDesktopRuntime', () => {
    it('reads the valid server-only desktop contract', async () => {
        const expected = await writeRuntime()
        await expect(readDesktopRuntime()).resolves.toEqual(expected)
    })

    it('rejects a runtime file readable by other users', async () => {
        await writeRuntime()
        await chmod(join(root, 'runtime.json'), 0o644)
        await expect(readDesktopRuntime()).rejects.toThrow(/0600/)
    })

    it('rejects a non-loopback application origin', async () => {
        await writeRuntime({ app: { origin: 'https://example.com', sessionToken: 'a'.repeat(48) } })
        await expect(readDesktopRuntime()).rejects.toThrow(/loopback/)
    })

    it('rejects a data root that differs from the assigned directory', async () => {
        await writeRuntime({ dataRoot: join(root, 'elsewhere') })
        await expect(readDesktopRuntime()).rejects.toThrow(/data root/)
    })
})


const installId = '00000000-0000-4000-8000-000000000007'
async function ownedContext(workspaceId = 7) {
    root = await realpath(root)
    const dataRoot = join(root, 'workspaces', String(workspaceId))
    const engineRoot = join(dataRoot, 'engine')
    await mkdir(engineRoot, { recursive: true })
    await writeFile(join(engineRoot, 'desktop-owner.json'), JSON.stringify({ installId, workspaceId }), { mode: 0o600 })
    process.env.RERUN_DESKTOP_DATA_DIR = dataRoot
    process.env.RERUN_DESKTOP_INSTALL_DIR = root
    process.env.RERUN_DESKTOP_WORKSPACE_ID = String(workspaceId)
    process.env.RERUN_DESKTOP_ENGINE_ROOT = engineRoot
    process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
    process.env.RERUN_DESKTOP_WORKSPACE_NAME = `Workspace ${workspaceId}`
    const runtime = await writeRuntime({ workspaceId, installId, installRoot: root, dataRoot, engineRoot })
    return { ...runtime, workspaceId, installId, installRoot: root, dataRoot, engineRoot }
}

describe('actual desktop workspace storage identity', () => {
    it('accepts workspace N and uses its engine directory without appending the legacy workspace path', async () => {
        const expected = await ownedContext()
        const runtime = await readDesktopRuntime()
        expect(runtime).toEqual(expected)
        expect(desktopEngineRoot(runtime)).toBe(join(root, 'workspaces', '7', 'engine'))
        expect(desktopEngineParts(runtime)).toEqual(['engine'])
    })

    it('requires installation identity for a non-legacy workspace', async () => {
        const runtime = await ownedContext(7)
        const { installId: _installId, ...missingInstall } = runtime
        await writeRuntime(missingInstall)
        await expect(readDesktopRuntime()).rejects.toThrow(/installation identity|install.*missing/i)
    })

    it('rejects a runtime for another workspace even when its paths are otherwise internally consistent', async () => {
        await ownedContext(7)
        process.env.RERUN_DESKTOP_WORKSPACE_ID = '8'
        await expect(readDesktopRuntime()).rejects.toThrow(/workspace.*(?:identity|context)|assigned workspace/i)
    })

    it('rejects a sibling engine directory instead of reading through the active context', async () => {
        const runtime = await ownedContext(7)
        const sibling = join(root, 'workspaces', '8', 'engine')
        await mkdir(sibling, { recursive: true })
        await writeRuntime({ ...runtime, engineRoot: sibling })
        await expect(readDesktopRuntime()).rejects.toThrow(/engine storage|engine.*identity/i)
    })

    it.each([
        { installId, workspaceId: 8 },
        { installId: '00000000-0000-4000-8000-000000000008', workspaceId: 7 },
    ])('rejects an engine owner belonging to another workspace or installation: %j', async owner => {
        const runtime = await ownedContext(7)
        await writeFile(join(String(runtime.engineRoot), 'desktop-owner.json'), JSON.stringify(owner), { mode: 0o600 })
        await expect(readDesktopRuntime()).rejects.toThrow(/owner|ownership|installation/i)
    })

    it('refuses a linked engine component and never turns the sibling into active storage', async () => {
        const runtime = await ownedContext(7)
        const sibling = join(root, 'workspaces', '8', 'engine')
        await mkdir(sibling, { recursive: true })
        await rm(String(runtime.engineRoot), { recursive: true })
        await symlink(sibling, String(runtime.engineRoot))
        await expect(readDesktopRuntime()).rejects.toThrow(/ownership|engine.*changed/i)
    })

    it('serves health for the actual workspace and initializes only its own app database', async () => {
        const runtime = await ownedContext(7)
        const response = await desktopHealth(new Request(`${runtime.app.origin}/api/desktop/health`, {
            headers: { host: new URL(runtime.app.origin).host, cookie: `rerun-desktop-session=${runtime.app.sessionToken}` },
        }))
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toEqual({ protocolVersion: 1, launchNonce: runtime.launchNonce, buildId: runtime.buildId, workspaceId: 7, status: 'ready' })
        expect(JSON.stringify(body)).not.toContain(runtime.engine.apiKey)
        await expect(access(join(String(runtime.dataRoot), 'app.db'))).resolves.toBeUndefined()
        await expect(access(join(root, 'app.db'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(access(join(root, 'workspaces', '1', 'engine'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
})
