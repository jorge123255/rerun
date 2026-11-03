import { mkdtemp, chmod, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readDesktopRuntime } from './runtime'

const originalEnv = { ...process.env }
let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-runtime-'))
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_DATA_DIR = root
    process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
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
