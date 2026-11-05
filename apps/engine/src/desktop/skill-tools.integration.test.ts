import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunContext } from '../runtime/context.js'
import { prepareSkillHelperFixture } from './skill-publication.test-support.js'
import { acquireSkillLease } from './skill-publication-native.js'
import { publishNewSkill, setSkillPublishHooksForTests } from './skill-publication.js'

const originalEnv = { ...process.env }
const root = realpathSync(mkdtempSync(join(tmpdir(), 'rerun-skills-tools-')))
process.env.RERUN_DATA_DIR = root
process.env.RERUN_DESKTOP_APP = '1'
const { agentConfigSchema } = await import('../agents/types.js')
const { readAgentConfig } = await import('../agents/loader.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { agentDir, skillsDir, workspaceDir } = await import('../config/paths.js')
const { desktopSkillTools } = await import('./skill-tools.js')
const { buildTools } = await import('../tools/registry.js')
let fixture: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const id = 'skills-qa'
const config = () => agentConfigSchema.parse({ name: 'Skills QA', tools: { desktopToolGrants: { skills: true } } })
const context = (value = config(), signal?: AbortSignal) => ({ agent: { id, config: value }, sessionId: 'fixture-session', abortSignal: signal } as RunContext)
const options = { toolCallId: 'fixture-call', messages: [] }
beforeAll(async () => { fixture = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = fixture.path }, 30_000)
beforeEach(async () => {
    await mkdir(workspaceDir(id), { recursive: true })
    await writeAgentConfig(id, config())
    await publishNewSkill(skillsDir(id), 'notes', { name: 'Notes', description: '', body: 'Private procedure' })
})
afterEach(async () => { setSkillPublishHooksForTests(null); await rm(agentDir(id), { recursive: true, force: true }) })
afterAll(async () => { await fixture.close(); process.env = originalEnv; await rm(root, { recursive: true, force: true }) })

test('registry leaves Skills off by default and uses the desktop adapter only after the explicit grant', async () => {
    const disabled = agentConfigSchema.parse({ name: 'No tools' })
    expect(desktopSkillTools(context(disabled))).toEqual({})
    const built = await buildTools(context())
    try {
        expect(built.tools.skill_read).toBeDefined()
        expect(built.tools.skill_create).toBeDefined()
        expect(built.tools.fs_write).toBeUndefined()
        expect(await built.tools.skill_read!.execute!({ slug: 'notes' }, options)).toContain('Private procedure')
    } finally { await built.close() }
})

test.each(['grant', 'enabled'] as const)('a queued read refuses a %s revocation before exposing content', async field => {
    const owner = await acquireSkillLease(skillsDir(id), await stat(skillsDir(id), { bigint: true }))
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    setSkillPublishHooksForTests({ beforeLeaseAcquire: entered })
    const result = desktopSkillTools(context()).skill_read!.execute!({ slug: 'notes' }, options)
    try {
        await waiting
        const current = await readAgentConfig(id)
        if (field === 'grant') current.tools.desktopToolGrants = { skills: false }
        else current.enabled = false
        await writeAgentConfig(id, current)
        await owner.release()
        await expect(result).rejects.toThrow('turned off')
    } finally { await owner.release() }
})

test('Stop settles a queued read before the other lease is released and never later reveals its bytes', async () => {
    const owner = await acquireSkillLease(skillsDir(id), await stat(skillsDir(id), { bigint: true }))
    const controller = new AbortController()
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    setSkillPublishHooksForTests({ beforeLeaseAcquire: entered })
    const result = desktopSkillTools(context(undefined, controller.signal)).skill_read!.execute!({ slug: 'notes' }, options)
    try {
        await waiting
        controller.abort(new Error('Reply stopped'))
        await expect(result).rejects.toThrow('Reply stopped')
        owner.assertCurrent()
    } finally { await owner.release() }
})
