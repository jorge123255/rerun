import { afterAll, expect, test, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunContext } from '../runtime/context.js'

const originalDataDir = process.env.RERUN_DATA_DIR
const originalDesktop = process.env.RERUN_DESKTOP_APP
const root = mkdtempSync(join(tmpdir(), 'rerun-skill-proposal-merge-'))
process.env.RERUN_DATA_DIR = root
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { agentDir } = await import('../config/paths.js')
const { getSystemDb, closeSystemDb } = await import('../db/systemDb.js')
const { insertSkillProposal, transitionSkillProposal, getSkillProposal, listSessionSkillProposals } = await import('../db/repos/skill-proposals.js')
const { desktopSkillTools } = await import('./skill-tools.js')
const { skillProposeTool } = await import('../tools/builtin/skill-propose.js')

afterAll(async () => {
    if (originalDataDir === undefined) delete process.env.RERUN_DATA_DIR
    else process.env.RERUN_DATA_DIR = originalDataDir
    if (originalDesktop === undefined) delete process.env.RERUN_DESKTOP_APP
    else process.env.RERUN_DESKTOP_APP = originalDesktop
    await rm(root, { recursive: true, force: true })
})

test.each(['desktop', 'hosted'] as const)('%s tool does not claim a merge after the pending proposal is accepted', async mode => {
    if (mode === 'desktop') process.env.RERUN_DESKTOP_APP = '1'
    else delete process.env.RERUN_DESKTOP_APP
    const id = `proposal-${mode}`
    const sessionId = `session-${mode}`
    const config = agentConfigSchema.parse({ name: 'Proposal QA', tools: { desktopToolGrants: { skills: true } }, selfImprovement: { enabled: true } })
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, config)
    const row = await insertSkillProposal(id, {
        sessionId, runId: null, toolCallId: `first-${mode}`, mode: 'create', slug: null,
        title: 'Review checklist', summary: 'Review before sending', instruction: 'Review before sending.',
        fingerprint: 'original-rule', connectionId: null, provider: 'openai', model: 'original-model',
    })
    const ctx = {
        agent: { id, config, resolved: { connection: null, provider: 'openai', model: 'next-model' } },
        sessionId, provider: 'openai', model: 'next-model', skillProposals: [],
    } as unknown as RunContext
    const { client } = await getSystemDb(id)
    const execute = client.execute.bind(client)
    let entered!: () => void
    let release!: () => void
    const selected = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let held = false
    // Return the genuine pending-row SELECT only after acceptance has committed. The tool
    // then calls the real append repository against a row that has already been decided.
    const spy = vi.spyOn(client, 'execute').mockImplementation(async statement => {
        const result = await execute(statement)
        const sql = typeof statement === 'string' ? statement : statement.sql
        if (!held && sql.startsWith('select ') && sql.includes('"skill_proposals"') && sql.includes('"session_id"') && sql.includes('order by')) {
            held = true
            entered()
            await gate
        }
        return result
    })
    const tools = mode === 'desktop' ? desktopSkillTools(ctx) : skillProposeTool(ctx)
    const pending = Promise.resolve(tools.skill_propose!.execute!({
        mode: 'create', slug: null, title: 'Review checklist', summary: 'Also record the reviewer', instruction: 'Record the reviewer before sending.',
    }, { toolCallId: 'later-call', messages: [] }))
    try {
        await selected
        expect(await transitionSkillProposal(id, row.id, ['proposed'], 'accepted')).toBe(true)
        const accepted = await getSkillProposal(id, row.id)
        release()
        expect(await pending).toBe('Could not save the proposal. Nothing shown. Do not retry.')
        expect(ctx.skillProposals).toEqual([])
        expect(await getSkillProposal(id, row.id)).toEqual(accepted)
        expect(await listSessionSkillProposals(id, sessionId)).toHaveLength(1)
    } finally {
        release()
        await pending.catch(() => {})
        spy.mockRestore()
        closeSystemDb(id)
    }
})
