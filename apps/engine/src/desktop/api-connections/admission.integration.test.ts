import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let root: string
beforeEach(async () => {
    vi.resetModules()
    root = await mkdtemp(join(tmpdir(), 'rerun-api-admission-fixture-'))
    vi.stubEnv('RERUN_DATA_DIR', root)
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_API_KEY', '')
    vi.stubEnv('RERUN_HUB_BASE_URL', '')
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

it('binds real coworker preparation/background leases to the connection removal barrier', async () => {
    const { beginDesktopAgentWork } = await import('../agent-lifecycle.js')
    const { beginDesktopApiConnectionRemoval, desktopApiConnectionRemovalAvailable } = await import('./admission.js')
    const finish = beginDesktopAgentWork('offline-owner')
    try {
        expect(desktopApiConnectionRemovalAvailable()).toBe(false)
        expect(beginDesktopApiConnectionRemoval()).toBeNull()
    } finally { finish() }
    const release = beginDesktopApiConnectionRemoval()!
    try { expect(() => beginDesktopAgentWork('offline-owner')).toThrow('provider connection is being removed') }
    finally { release() }
    const final = beginDesktopAgentWork('offline-owner')
    final()
})
