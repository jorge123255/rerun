import { z } from 'zod'
import { MAX_SKILL_FILE_BYTES } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { deleteCoworkerSkill, getCoworkerSkill, updateCoworkerSkill } from '@/lib/desktop/server/coworker-skills'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readCoworkerSkillBody } from '@/lib/desktop/server/coworker-skill-body'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string; slug: string }> }

const skillPatchSchema = z.object({
    description: z.string().max(500).optional(),
    body: z.string().min(1).optional(),
    baseIdentity: z.string().min(1).max(512),
}).strict().refine(value => value.body !== undefined || value.description !== undefined)

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId, slug } = await params
        if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw new DesktopHttpError(400, 'Invalid skill slug.')
        const skill = await getCoworkerSkill(runtime, agentId, slug)
        if (!skill) throw new DesktopHttpError(404, 'Skill not found.')
        return Response.json({ skill }, { headers: { 'cache-control': 'no-store' } })
    })
}

export function PATCH(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const patch = skillPatchSchema.safeParse(await readCoworkerSkillBody(request, MAX_SKILL_FILE_BYTES + 65_536))
        if (!patch.success) throw new DesktopHttpError(400, 'Reopen this skill before saving its changes.')
        const { agentId, slug } = await params
        if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw new DesktopHttpError(400, 'Invalid skill slug.')
        const result = await updateCoworkerSkill(runtime, agentId, slug, patch.data)
        if (!result.success || !result.skill) throw new DesktopHttpError(result.status ?? 400, result.error ?? 'Failed to update the skill.')
        return Response.json({ skill: result.skill })
    })
}

export function DELETE(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId, slug } = await params
        if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw new DesktopHttpError(400, 'Invalid skill slug.')
        const result = await deleteCoworkerSkill(runtime, agentId, slug)
        if (!result.success) throw new DesktopHttpError(400, result.error ?? 'Failed to delete the skill.')
        return new Response(null, { status: 204 })
    })
}
