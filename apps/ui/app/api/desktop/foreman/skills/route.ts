import { FOREMAN_AGENT_ID, foremanChatRefSchema, skillProposalDecisionSchema, skillProposalSchema, type DesktopForemanChatRef } from '@rerun/contracts'
import { z } from 'zod'
import { EngineRequestError, getSkill, listSkillSummaries, request as engineRequest } from '@/lib/engine/client'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { readCoworkerSkillBody } from '@/lib/desktop/server/coworker-skill-body'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { ownedForemanChat } from '@/lib/desktop/server/foreman/chat-store'
import { assertCurrentChiefSkillWorkspace, assertManagedSkillChief } from '@/lib/desktop/server/foreman/skill-authority'
import { desktopRoute } from '@/lib/desktop/server/http'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { engineOf } from '@/lib/desktop/server/settings'

export const dynamic = 'force-dynamic'

const revision = z.string().regex(/^[a-f0-9]{64}$/)
const proposal = skillProposalSchema.extend({ revision })
const proposalList = z.object({ proposals: z.array(proposal) })
const decisionRequest = z.strictObject({
    chat: foremanChatRefSchema, proposalId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), decision: skillProposalDecisionSchema, revision,
})
const skillSlug = /^[a-z0-9-]{1,64}$/
const noStore = { headers: { 'cache-control': 'no-store' } }

async function withChiefSkills<T>(runtime: DesktopRuntime, chat: DesktopForemanChatRef, signal: AbortSignal,
    work: (sessionId: string, current: () => Promise<void>) => Promise<T>) {
    if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Chief of Staff conversation not found.')
    const db = await openDesktopDatabase(runtime.dataRoot)
    const owner = await ownedForemanChat(db, chat)
    const current = async () => {
        signal.throwIfAborted()
        await assertCurrentChiefSkillWorkspace(runtime)
        if ((await ownedForemanChat(db, chat)).sessionId !== owner.sessionId)
            throw new DesktopHttpError(409, 'This conversation changed. Reopen its skills.')
    }
    try {
        await assertManagedSkillChief(runtime, signal)
        const result = await work(owner.sessionId, current)
        await current()
        return result
    } catch (error) {
        if (error instanceof EngineRequestError) {
            if (error.status === 404) throw new DesktopHttpError(404, 'Skill or proposal not found.')
            if (error.status === 409) throw new DesktopHttpError(409, 'The skill proposal changed. Review it again.')
            throw new DesktopHttpError(502, 'Could not reach Chief of Staff’s skills.')
        }
        throw error
    }
}

function readProposals(runtime: DesktopRuntime, sessionId: string, signal: AbortSignal) {
    return engineRequest(engineOf(runtime), '/agents/foreman/skill-proposals?session=' + encodeURIComponent(sessionId), { method: 'GET', signal }, data => {
        const { proposals } = proposalList.parse(data)
        if (proposals.some(row => row.sessionId !== sessionId)) throw new DesktopHttpError(502, 'Could not confirm the proposal’s conversation.')
        return proposals
    })
}

export function GET(req: Request) {
    return desktopRoute(req, async runtime => {
        const query = new URL(req.url).searchParams
        const chat = foremanChatRefSchema.safeParse({ workspaceId: query.get('workspaceId'), chatId: query.get('chatId') })
        if (!chat.success) throw new DesktopHttpError(400, 'Choose a Chief of Staff conversation.')
        const slug = query.get('slug')
        if (slug !== null && (!skillSlug.test(slug) || slug.startsWith('svc-'))) throw new DesktopHttpError(404, 'Skill not found.')
        const signal = AbortSignal.any([req.signal, AbortSignal.timeout(10_000)])
        const result = await withChiefSkills(runtime, chat.data, signal, async sessionId => {
            if (slug !== null) {
                const skill = await getSkill(engineOf(runtime), FOREMAN_AGENT_ID, slug)
                if (skill.slug !== slug) throw new DesktopHttpError(502, 'Could not confirm the requested skill.')
                return { skill: { slug: skill.slug, name: skill.name, description: skill.description, body: skill.body } }
            }
            const [skills, proposals] = await Promise.all([listSkillSummaries(engineOf(runtime), FOREMAN_AGENT_ID), readProposals(runtime, sessionId, signal)])
            return { skills: skills.filter(skill => !skill.slug.startsWith('svc-')), proposals }
        })
        return Response.json({ chat: chat.data, ...result }, noStore)
    })
}

export function POST(req: Request) {
    return desktopRoute(req, async runtime => {
        const body = decisionRequest.safeParse(await readCoworkerSkillBody(req, 4096))
        if (!body.success) throw new DesktopHttpError(400, 'Choose a reviewed proposal and its decision.')
        const { chat, proposalId, decision, revision } = body.data
        const signal = AbortSignal.any([req.signal, AbortSignal.timeout(10_000)])
        const result = await withChiefSkills(runtime, chat, signal, async (sessionId, current) => {
            await current()
            // The engine checks both the originating session and the reviewed revision when it claims the decision.
            const path = '/agents/foreman/skill-proposals/' + encodeURIComponent(proposalId) + '/' + decision + '?session=' + encodeURIComponent(sessionId)
            const row = await engineRequest(engineOf(runtime), path, { method: 'POST', headers: { 'If-Match': '"' + revision + '"' }, signal },
                data => z.object({ proposal }).parse(data).proposal)
            if (row.id !== proposalId || row.sessionId !== sessionId) throw new DesktopHttpError(502, 'Could not confirm the proposal decision.')
            return row
        })
        return Response.json({ chat, proposal: result }, noStore)
    })
}
