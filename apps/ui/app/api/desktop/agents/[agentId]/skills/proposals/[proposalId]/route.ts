import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { decideCoworkerSkillProposal } from '@/lib/desktop/server/coworker-skills'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readCoworkerSkillBody } from '@/lib/desktop/server/coworker-skill-body'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string; proposalId: string }> }

const decideSchema = z.object({ decision: z.enum(['accept', 'dismiss']), sessionId: z.string().min(1).max(128).optional() }).strict()

export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const decision = decideSchema.safeParse(await readCoworkerSkillBody(request, 4096))
        if (!decision.success) throw new DesktopHttpError(400, 'Choose accept or dismiss.')
        const { agentId, proposalId } = await params
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(proposalId)) throw new DesktopHttpError(400, 'Invalid proposal id.')
        const result = await decideCoworkerSkillProposal(runtime, agentId, proposalId, decision.data.decision, decision.data.sessionId)
        if (!result.success || !result.proposal) throw new DesktopHttpError(result.status ?? 400, result.error ?? 'Failed to update the proposal.')
        return Response.json({ proposal: result.proposal })
    })
}
