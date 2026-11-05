import { z } from 'zod'
import { connectorSkillReadOnlyError } from '@rerun/contracts'
import { modelFor } from '../agents/providers.js'
import { isUsable, resolveRunModel } from '../agents/availability.js'
import { ensureCliAuth } from '../connections/cli-auth.js'
import { syncCodexAuth } from '../connections/codex-auth.js'
import { generateStructured } from '../agents/structured.js'
import { connectorSkillOwners } from '../services/registry.js'
import { listSkillSummaries, readSkill, skillExists, writeSkillFolder, type SkillSummary } from './loader.js'
import { desktopApp } from '../desktop/policy.js'
import { beginDesktopSkillProposal } from '../desktop/skill-proposal-work.js'
import { publishAuthorizedDesktopSkill } from '../desktop/skill-proposal-apply.js'
import { listPublishedSkills, readPublishedSkill } from '../desktop/skill-publication.js'
import { skillsDir } from '../config/paths.js'
import { readAgentConfig } from '../agents/loader.js'
import { getSkillProposal, transitionSkillProposal } from '../db/repos/skill-proposals.js'
import { slugify } from '../lib/ids.js'
import { logger } from '../lib/logger.js'
import type { LoadedAgent } from '../agents/types.js'
import type { SkillProposalRow } from '../db/schema.js'

// A CLI provider that hangs would otherwise leave the row on `accepted` with nothing to settle it.
const APPLY_TIMEOUT_MS = 10 * 60 * 1000

const draftSchema = z.object({
    name: z.string().describe('The skill name, kept as it is when editing an existing skill'),
    description: z.string().describe('One line saying when this skill applies'),
    body: z.string().describe('The complete SKILL.md body in Markdown, the full revised procedure rather than a diff'),
})

export function applyProposalPrompt(input: {
    title: string
    instructions: string[]
    current: { name: string; description: string; body: string } | null
    others: SkillSummary[]
}): string {
    const rules = input.instructions.map(r => `- ${r}`).join('\n')

    if (input.current) {
        return `The user approved folding these rules into an existing skill.\n\nRules:\n${rules}\n\nCurrent skill "${input.current.name}" (${input.current.description}):\n\n${input.current.body}\n\nReturn the complete revised skill. Change only what the rules touch and keep every other line exactly as it is. Keep the name unchanged. Write it as instructions to the coworker's future self: the steps in order, the exact tool calls, the decisions and their criteria, and how to tell the work is done. No preamble, no mention of this conversation.`
    }

    const neighbours = input.others.length ? `\n\nSkills this coworker already has, so stay off their ground:\n${input.others.map(s => `- ${s.name}: ${s.description}`).join('\n')}` : ''
    return `The user approved capturing these rules as a new skill named "${input.title}".\n\nRules:\n${rules}${neighbours}\n\nWrite the skill. Keep it short and actionable, written as instructions to the coworker's future self: the steps in order, the exact tool calls, the decisions and their criteria, and how to tell the work is done. No preamble, no mention of this conversation.`
}

async function draft(agent: LoadedAgent, row: SkillProposalRow, abortSignal: AbortSignal): Promise<{ name: string; description: string; body: string; slug: string; baseIdentity?: string }> {
    const instructions = JSON.parse(row.instructionsJson) as string[]
    const desktop = desktopApp()
    const editing = row.mode === 'edit' && row.slug ? desktop ? await readPublishedSkill(skillsDir(agent.id), row.slug, { signal: abortSignal }) : await readSkill(agent.id, row.slug) : null
    if (row.mode === 'edit' && !editing) throw new Error('That skill no longer exists.')
    const others = editing ? [] : desktop ? await listPublishedSkills(skillsDir(agent.id), { signal: abortSignal }) : await listSkillSummaries(agent.id).catch(() => [])

    const output = await generateStructured({
        model: modelFor(agent),
        schema: draftSchema,
        prompt: applyProposalPrompt({ title: row.title, instructions, current: editing, others }),
        abortSignal,
    })

    // An edit keeps the folder it was read from: writeSkill would re-slugify from the name and
    // fork a second skill the moment the two ever drifted apart.
    const slug = editing ? editing.slug : slugify(output.name || row.title)
    return { ...output, name: editing ? editing.name : output.name, slug, ...(desktop && editing && 'identity' in editing ? { baseIdentity: editing.identity as string | undefined } : {}) }
}

// The accept click comes with no model of its own, so the job writes on the pair the proposing
// conversation ran on: the agent's own pair may be one the user is not paying through, like a
// Rerun budget already spent while they chat on their Claude subscription. A connection removed or
// signed out since then falls back to the agent's pair rather than sending its model elsewhere.
async function agentForProposal(agent: LoadedAgent, row: SkillProposalRow): Promise<LoadedAgent> {
    if (!row.provider || !row.model) return agent
    const resolved = await resolveRunModel(agent, { connectionId: row.connectionId ?? undefined, provider: row.provider, model: row.model })
    if (resolved.provider !== row.provider || !isUsable(resolved.connection, resolved.model)) return agent
    return { ...agent, resolved }
}

export async function applySkillProposal(agent: LoadedAgent, row: SkillProposalRow): Promise<void> {
    let release = () => {}
    let work: ReturnType<typeof beginDesktopSkillProposal> | undefined
    let provider = agent.resolved.provider
    let connection = agent.resolved.connection
    const desktop = desktopApp()
    try {
        if (desktop) work = beginDesktopSkillProposal(agent.id, row.id)
        const signal = work ? AbortSignal.any([work.signal, AbortSignal.timeout(APPLY_TIMEOUT_MS)]) : AbortSignal.timeout(APPLY_TIMEOUT_MS)
        const admitted = async () => {
            signal.throwIfAborted()
            if (!desktop) return
            const current = await getSkillProposal(agent.id, row.id)
            if (!current || current.status !== 'accepted' || current.sessionId !== row.sessionId || current.mode !== row.mode || current.slug !== row.slug || current.instructionsJson !== row.instructionsJson) throw new Error('This proposal changed. Review it again before applying.')
            if (!(await readAgentConfig(agent.id).catch(() => null))?.enabled) throw new Error('This coworker is turned off.')
            signal.throwIfAborted()
        }
        await admitted()
        const writer = await agentForProposal(agent, row).catch(() => agent)
        provider = writer.resolved.provider
        connection = writer.resolved.connection
        if (!desktop && row.mode === 'edit' && (!row.slug || !skillExists(agent.id, row.slug))) throw new Error('That skill no longer exists.')
        release = await ensureCliAuth(provider, connection)
        await admitted()
        const result = await draft(writer, row, signal)
        await admitted()
        if (desktop) {
            await publishAuthorizedDesktopSkill(agent.id, { ...result, files: [] }, true, { mode: row.mode as 'create' | 'edit', signal, beforeCommit: admitted })
        } else {
            const service = (await connectorSkillOwners(agent.id)).get(result.slug)
            if (service) throw new Error(connectorSkillReadOnlyError(result.slug, service))
            await writeSkillFolder(agent.id, { ...result, files: [] })
        }
        await transitionSkillProposal(agent.id, row.id, ['accepted'], 'applied', { appliedSlug: result.slug, error: null })
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        logger.warn({ err: error, agent: agent.id, proposal: row.id }, 'skill proposal apply failed')
        await transitionSkillProposal(agent.id, row.id, ['accepted'], 'failed', { error })
    } finally {
        release()
        if (provider === 'codex') await syncCodexAuth(connection).catch(() => {})
        work?.release()
    }
}
