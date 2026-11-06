import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'

it('initializes once, stays off and reopens an existing directory after close without enabling a port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-mcp-runtime-'))
    vi.stubEnv('RERUN_DATA_DIR', root)
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const runtime = await import('./runtime.js')
    try {
        await Promise.all([runtime.initializeDesktopExternalMcp(), runtime.initializeDesktopExternalMcp()])
        const first = runtime.getExternalMcpService()
        await runtime.initializeDesktopExternalMcp()
        expect(runtime.getExternalMcpService()).toBe(first)
        expect((await first.listener()).enabled).toBe(false)
        await runtime.closeDesktopExternalMcp()
        await runtime.initializeDesktopExternalMcp()
        expect(runtime.getExternalMcpService()).not.toBe(first)
        expect((await runtime.getExternalMcpService().listener()).enabled).toBe(false)
    } finally {
        await runtime.closeDesktopExternalMcp()
        vi.unstubAllEnvs()
        await rm(root, { recursive: true, force: true })
    }
})

it('keeps the same service and open receipt database after failed cleanup, then closes on retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-mcp-stop-retry-'))
    vi.stubEnv('RERUN_DATA_DIR', root)
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const runtime = await import('./runtime.js')
    try {
        await runtime.initializeDesktopExternalMcp()
        const service = runtime.getExternalMcpService(), close = service.close
        service.close = vi.fn().mockRejectedValueOnce(new Error('Pending external writer'))
        await expect(runtime.closeDesktopExternalMcp()).rejects.toThrow('Pending external writer')
        expect(runtime.getExternalMcpService()).toBe(service)
        service.close = close
        // Reinitializing reads and writes the same SQLite schema; a prematurely closed client
        // would fail here, even though the service identity is still present.
        await expect(service.initialize()).resolves.toBeUndefined()
        await runtime.closeDesktopExternalMcp()
        expect(() => runtime.getExternalMcpService()).toThrow('not initialized')
    } finally {
        await runtime.closeDesktopExternalMcp()
        vi.unstubAllEnvs()
        await rm(root, { recursive: true, force: true })
    }
})
