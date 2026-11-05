import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = realpathSync(mkdtempSync(resolve(tmpdir(), 'rerun-desktop-setup-')))
process.env.RERUN_API_KEY = ''

const { afterAll, beforeAll, describe, expect, it } = await import('vitest')
const { mkdir, readFile, writeFile } = await import('node:fs/promises')
const { agentDir, dataDir, configPath, installPath } = await import('../../config/paths.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { getAgent, reloadAgent } = await import('../../agents/registry.js')
const { claimDesktopSetupSession, continueDesktopSetupSession, desktopSetupRunAllowed, desktopSetupTools, isDesktopSetupTool, initializeImportedSetup, readDesktopSetup, saveDesktopSetup } = await import('./service.js')
const { sealManifest } = await import('../templates/install.js')
const { DESKTOP_TEMPLATE_LIMITS, DESKTOP_TEMPLATE_PROSE_WARNING } = await import('@rerun/contracts')
const { claimSession, registerRunAbort, unregisterRunAbort } = await import('../../runtime/run-control.js')
const { startRun } = await import('../../db/repos/runs.js')
import type { RunContext } from '../../runtime/context.js'

const {prepareSkillHelperFixture}=await import('../skill-publication.test-support.js')
let helper:Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const previousHelper=process.env.RERUN_DESKTOP_RENAME_HELPER
beforeAll(async()=>{helper=await prepareSkillHelperFixture();process.env.RERUN_DESKTOP_RENAME_HELPER=helper.path})
afterAll(async()=>{if(previousHelper===undefined)delete process.env.RERUN_DESKTOP_RENAME_HELPER;else process.env.RERUN_DESKTOP_RENAME_HELPER=previousHelper;await helper.close()})

async function seed(id: string, setup: { required?: boolean | null; completedAt?: string | null; sessionId?: string | null } = {}) {
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, agentConfigSchema.parse({ name: id, setup: { required: setup.required ?? null, completedAt: setup.completedAt ?? null, sessionId: setup.sessionId ?? null } }))
}

async function seedImport() {
    const id = `i${'a'.repeat(31)}`
    const importReceiptId = '11111111-1111-4111-8111-111111111111'
    await seed(id)
    const manifest = sealManifest({ version: 1, kind: 'desktop-local-template', templateId: 'a'.repeat(32), title: 'Setup fixture', capturedAt: new Date().toISOString(), planRevision: 'b'.repeat(64), requestId: importReceiptId,
        proseWarning: DESKTOP_TEMPLATE_PROSE_WARNING, limits: DESKTOP_TEMPLATE_LIMITS, engineCommit: null,
        coworkers: [{ agentKey: 'c00', sourceEngineId: 'source', name: 'Setup fixture', description: '', setup: { prompt: 'Set up email.', required: true, answered: true }, files: [], exclusions: [], redactions: [], strippedConfigKeys: [] }] })
    const directory = resolve(dataDir(), 'desktop-templates', manifest.templateId, 'revisions', manifest.revision)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(resolve(agentDir(id), '.desktop-template-import.json'), JSON.stringify({ version: 1, importReceiptId, templateId: manifest.templateId, revision: manifest.revision, engineAgentId: id, agentKey: 'c00', phase: 'indexed' }))
    return { agentId: '22222222-2222-4222-8222-222222222222', engineAgentId: id, importReceiptId, prompt: 'Set up email.', required: true }
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
        const input = await seedImport()
        const first = await initializeImportedSetup(input)
        const second = await initializeImportedSetup(input)
        expect(second.revision).toBe(first.revision)
        const record = await readDesktopSetup(input.engineAgentId)
        expect(record.pending).toBe(true)
        expect(record.completedAt).toBeNull()
        expect(record.sessionId).toBeNull()
        expect(record.prompt).toBe('Set up email.')
        await expect(initializeImportedSetup({ ...input, prompt: 'Different.' })).rejects.toThrow('different request')
        await expect(initializeImportedSetup({ ...input, agentId: '33333333-3333-4333-8333-333333333333' })).rejects.toThrow('different request')
        await saveDesktopSetup(input.engineAgentId, { prompt: 'Edited later.', required: true })
        expect(await initializeImportedSetup(input)).toEqual(first)
        expect((await readDesktopSetup(input.engineAgentId)).prompt).toBe('Edited later.')
        expect((await readDesktopSetup(input.engineAgentId)).completedAt).not.toBeNull()
    })

    it('refuses an initializer without an indexed template binding', async () => {
        await seed('not-imported')
        await expect(initializeImportedSetup({ agentId: 'owner', engineAgentId: 'not-imported', importReceiptId: 'receipt', prompt: 'Reset me', required: true })).rejects.toThrow('not owned')
        expect((await readDesktopSetup('not-imported')).prompt).toBe('')
    })

    it('replays the saved target after an interrupted save and rejects identity reuse', async () => {
        await seed('save-recovery')
        const input = { requestId: '44444444-4444-4444-8444-444444444444', expectedRevision: (await readDesktopSetup('save-recovery')).revision, prompt: 'Exact target.', required: true }
        const first = await saveDesktopSetup('save-recovery', input)
        const journalPath = resolve(agentDir('save-recovery'), '.desktop-setup-journal.json')
        const journal = JSON.parse(await readFile(journalPath, 'utf8'))
        journal.active = input.requestId
        delete journal.entries[input.requestId].result
        await writeFile(journalPath, JSON.stringify(journal))
        await writeFile(installPath('save-recovery'), 'Interrupted intermediate text')
        expect(await saveDesktopSetup('save-recovery', input)).toEqual(first)
        expect(await saveDesktopSetup('save-recovery', input)).toEqual(first)
        await expect(saveDesktopSetup('save-recovery', { ...input, prompt: 'Different' })).rejects.toThrow('different change')
        await expect(saveDesktopSetup('save-recovery', { ...input, requestId: '55555555-5555-4555-8555-555555555555' })).rejects.toThrow('changed since')
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

    it('claim refuses completed setup rather than creating an ordinary chat', async () => {
        await seed('already-done', { required: true, completedAt: new Date().toISOString() })
        await writeFile(installPath('already-done'), 'Completed instructions')
        await expect(claimDesktopSetupSession('already-done')).rejects.toThrow('does not have pending setup')
    })

    it('install_complete gate allows only the claimed session', async () => {
        await seed('gated', { required: true, sessionId: 'sess-1' })
        await writeFile(installPath('gated'), 'Do the thing.\n')
        const agent = await getAgent('gated')
        expect(desktopSetupRunAllowed(agent, 'sess-1')).toBe(true)
        expect(desktopSetupRunAllowed(agent, 'sess-2')).toBe(false)
        expect(desktopSetupRunAllowed(agent, 'sess-1')).toBe(true)
        await writeAgentConfig('gated', agentConfigSchema.parse({ name: 'gated', setup: { required: true, completedAt: '2026-01-01T00:00:00Z', sessionId: 'sess-1' } }))
        expect(desktopSetupRunAllowed(await reloadAgent('gated'), 'sess-1')).toBe(false)
    })

    it('only a live claimed setup run can complete, and a stopped run cannot replay success', async () => {
        const id = 'complete-authority'
        await seed(id, { required: true })
        await writeFile(installPath(id), 'Verify setup.')
        const claim = await claimDesktopSetupSession(id)
        if (!('session' in claim)) throw new Error('Expected a fresh claim')
        const runId = '66666666-6666-4666-8666-666666666666'
        claimSession(claim.session.id, runId)
        const controller = registerRunAbort(runId)
        await startRun(id, claim.session.id, runId)
        const ctx = { agent: await getAgent(id), sessionId: claim.session.id, runId, abortSignal: controller.signal } as RunContext
        const complete = desktopSetupTools(ctx).install_complete!
        const execute = complete.execute as (input: { summary: string }, options: object) => Promise<{ status: string; alreadyComplete: boolean }>
        try {
            expect(isDesktopSetupTool(complete, id)).toBe(true)
            expect(isDesktopSetupTool({ ...complete }, id)).toBe(false)
            expect(isDesktopSetupTool(complete, 'another-owner')).toBe(false)
            expect(await execute({ summary: 'Verified' }, {})).toMatchObject({ status: 'complete', alreadyComplete: false })
            expect(await execute({ summary: 'Verified' }, {})).toMatchObject({ status: 'complete', alreadyComplete: true })
            controller.abort()
            expect(isDesktopSetupTool(complete, id)).toBe(false)
            await expect(execute({ summary: 'Too late' }, {})).rejects.toThrow()
        } finally { unregisterRunAbort(runId) }
    })
})
