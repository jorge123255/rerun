import { addDesktopMemory, recallDesktopMemory, removeDesktopMemory, updateDesktopMemory } from '../desktop/memory-store.js'
import { desktopApp } from '../desktop/policy.js'
import { applyDesktopLearning, withDesktopLearning } from '../desktop/learning.js'
import { z } from 'zod'
import { modelFor, type ModelOverride } from '../agents/providers.js'
import { ensureCliAuth } from '../connections/cli-auth.js'
import { generateStructured } from '../agents/structured.js'
import { writeMemory, updateMemory, deleteMemory, recallMemory, type RecalledMemory } from '../memory/store.js'
import { listSkillSummaries, type SkillSummary } from '../skills/loader.js'
import { logger } from '../lib/logger.js'
import type { LoadedAgent } from '../agents/types.js'

const CURATOR_TIMEOUT_MS = 10 * 60 * 1000

export const curationSchema = z.object({
    memory: z
        .object({
            content: z.string().describe('The durable, self-contained fact to remember'),
            updateId: z
                .string()
                .nullable()
                .describe('If this fact updates or supersedes one of the existing related memories shown to you, set it to that memory id. Otherwise null to store a new memory.'),
        })
        .nullable()
        .describe('A durable, standalone fact or standing preference worth remembering across conversations, never a rule about how the work is done even when phrased as a preference, or null if nothing is worth keeping'),
    obsoleteIds: z.array(z.string()).describe('Ids of existing related memories now wrong or fully contradicted by this exchange, which should be deleted; return an empty array when none are obsolete'),
})

export function curatorPrompt({ userText, assistantText, existing, skills }: { userText: string; assistantText: string; existing: RecalledMemory[]; skills: SkillSummary[] }): string {
    const skillsBlock = skills.length
        ? `\n\nThese skills already govern how this coworker works, so anything belonging to one of them is not a memory:\n${skills.map(s => `- ${s.name} (slug: ${s.slug}): ${s.description}`).join('\n')}`
        : ''
    const existingBlock = existing.length
        ? `\n\nExisting related memories you already hold. You may UPDATE one in place by returning its id, or mark some obsolete to delete:\n${existing.map(m => `- [${m.id}] (${m.kind}) ${m.content}`).join('\n')}`
        : ''

    return `Review this exchange and decide what is worth remembering for the future.\n\nUser: ${userText}\n\nAssistant: ${assistantText}\n\nReturn a durable memory if a lasting fact emerged, otherwise null. Anything that says how the work is done belongs in a skill, not in memory: a procedure, a checklist, a workflow, an output format, a calibre or length target, a naming or style convention, a rule for a recurring task, or a correction of what the assistant just produced. Return null for all of it, even when it is phrased as a preference, and never fold it into an existing memory through updateId. Memory is the fallback for what no skill governs: standalone facts and standing preferences. If the exchange corrects or refines one of the existing related memories shown to you, update it in place by returning its id rather than storing a duplicate.${skillsBlock}${existingBlock}`
}

export async function runCurator(agent: LoadedAgent, sessionId: string, userText: string, assistantText: string, override?: ModelOverride): Promise<void> {
    if (!agent.config.selfImprovement.autoMemory) return
    if (desktopApp()) {
        if (!agent.config.tools.memory) return
        return withDesktopLearning(agent.id, stop => reviewExchange(agent, userText, assistantText, override, stop))
    }
    return reviewExchange(agent, userText, assistantText, override)
}

async function reviewExchange(agent: LoadedAgent, userText: string, assistantText: string, override?: ModelOverride, stop?: AbortSignal) {
    const query = `${userText}\n\n${assistantText}`
    const candidates = stop
        ? recallDesktopMemory(agent.id, query, 5, { purpose: 'curation', includeDormant: true })
        : recallMemory(agent, query, 5, { reinforce: 'none', includeDormant: true })
    const [existing, skills] = await Promise.all([
        candidates.catch(() => []),
        agent.config.tools.skills ? listSkillSummaries(agent.id).catch(() => []) : Promise.resolve([]),
    ])
    if (stop?.aborted) return
    const release = await ensureCliAuth(agent.resolved.provider, agent.resolved.connection)
    if (stop?.aborted) { release(); return }
    const timeout = AbortSignal.timeout(CURATOR_TIMEOUT_MS)
    const output = await generateStructured({
        model: modelFor(agent, override),
        schema: curationSchema,
        prompt: curatorPrompt({ userText, assistantText, existing, skills }),
        abortSignal: stop ? AbortSignal.any([stop, timeout]) : timeout,
    }).finally(release)

    const known = new Map(existing.map(memory => [memory.id, memory]))
    if (stop) return applyDesktopLearning(agent.id, stop, () => applyCuration(agent, known, output, true))
    return applyCuration(agent, known, output, false)
}

async function applyCuration(agent: LoadedAgent, known: Map<string, RecalledMemory>, output: z.infer<typeof curationSchema>, desktop: boolean) {
    const update = output.memory?.updateId ? known.get(output.memory.updateId) : undefined
    for (const id of output.obsoleteIds) {
        const note = known.get(id)
        if (!note || id === update?.id) continue
        const deletion = desktop ? removeDesktopMemory(agent.id, id, note.content) : deleteMemory(agent, id)
        await deletion.catch(e => logger.warn({ err: String(e) }, 'auto memory delete failed'))
    }
    if (output.memory) {
        const { content } = output.memory
        if (update) {
            const change = desktop ? updateDesktopMemory(agent.id, update.id, update.content, content) : updateMemory(agent, update.id, content)
            await change.catch(e => logger.warn({ err: String(e) }, 'auto memory update failed'))
        } else {
            const addition = desktop ? addDesktopMemory(agent.id, { content: content.trim(), kind: 'learned', tags: [] }) : writeMemory(agent, content, 'learned')
            await addition.catch(e => logger.warn({ err: String(e) }, 'auto memory failed'))
        }
    }
}
