import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-desktop-setup-'))
process.env.RERUN_API_KEY = ''

const { describe, expect, it } = await import('vitest')
const { mkdir, readFile, writeFile } = await import('node:fs/promises')
const { agentDir, configPath, installPath } = await import('../../config/paths.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { getAgent } = await import('../../agents/registry.js')
const { claimDesktopSetupSession, continueDesktopSetupSession, desktopSetupRunAllowed, initializeImportedSetup, readDesktopSetup, saveDesktopSetup } = await import('./service.js')

async function seed(id: string, setup: { required?: boolean | null; completedAt?: string | null; sessionId?: string | null } = {}) {
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, agentConfigSchema.parse({ name: id, setup: { required: setup.required ?? null, completedAt: setup.completedAt ?? null, sessionId: setup.sessionId ?? null } }))
}

describe('desktop setup service', () => {
    it('author save writes INSTALL.md and completes the author setup', async () => {
        await seed('author')
        const saved = await saveDesktopSetup('author', { prompt: 'Connect the CRM.', required: true })
        expect(saved.completedAt).not.toBeNull()
        expect(saved.pending).toBe(false)
        expect(await readFile(installPath('author'), 'utf8')).toBe('Connect the CRM.\n')
        expect((await getAgent('author')).config.setup.required).toBe(true)
    })

    it('imported copies start pending and the initializer is idempotent per receipt', async () => {
        await seed('imported')
        const first = await initializeImportedSetup({ agentId: 'cow-1', engineAgentId: 'imported', importReceiptId: 'receipt-1', prompt: 'Set up email.', required: true })
        const second = await initializeImportedSetup({ agentId: 'cow-1', engineAgentId: 'imported', importReceiptId: 'receipt-1', prompt: 'Different.', required: true })
        expect(second.revision).toBe(first.revision)
        const record = await readDesktopSetup('imported')
        expect(record.pending).toBe(true)
        expect(record.completedAt).toBeNull()
        expect(record.sessionId).toBeNull()
        expect(record.prompt).toBe('Set up email.')
    })

    it('start claims exactly one session and continue reconciles it', async () => {
        await seed('guided', { required: true })
        await writeFile(installPath('guided'), 'Do the thing.\n')
        const claim = await claimDesktopSetupSession('guided')
        expect('session' in claim).toBe(true)
        if (!('session' in claim)) return
        const again = await claimDesktopSetupSession('guided')
        expect(again).toEqual({ inFlight: claim.session.id })
        const continued = await continueDesktopSetupSession('guided')
        expect(continued.id).toBe(claim.session.id)
    })

    it('continue refuses without a claimed chat', async () => {
        await seed('unclaimed', { required: true })
        await writeFile(installPath('unclaimed'), 'Do the thing.\n')
        await expect(continueDesktopSetupSession('unclaimed')).rejects.toThrow('no setup chat')
    })

    it('install_complete gate allows only the claimed session', async () => {
        await seed('gated', { required: true, sessionId: 'sess-1' })
        await writeFile(installPath('gated'), 'Do the thing.\n')
        const agent = await getAgent('gated')
        expect(desktopSetupRunAllowed(agent, 'sess-1')).toBe(true)
        expect(desktopSetupRunAllowed(agent, 'sess-2')).toBe(false)
        expect(desktopSetupRunAllowed(agent, 'sess-1')).toBe(true)
        await writeAgentConfig('gated', agentConfigSchema.parse({ name: 'gated', setup: { required: true, completedAt: '2026-01-01T00:00:00Z', sessionId: 'sess-1' } }))
        expect(desktopSetupRunAllowed(await getAgent('gated'), 'sess-1')).toBe(false)
    })
})
