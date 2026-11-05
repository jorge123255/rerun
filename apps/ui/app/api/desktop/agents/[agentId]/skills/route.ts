import { z } from 'zod'
import { MAX_SKILL_REFERENCE_FILES, MAX_SKILL_FOLDER_BYTES, skillFilePayloadSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { createCoworkerSkill, importCoworkerSkill, listCoworkerSkills } from '@/lib/desktop/server/coworker-skills'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readCoworkerSkillBody } from '@/lib/desktop/server/coworker-skill-body'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

const skillCreateSchema = z.object({
    kind: z.literal('create'),
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional().default(''),
    body: z.string().min(1),
}).strict()
const skillImportSchema = z.object({
    kind: z.literal('import'),
    content: z.string().min(1),
    files: z.array(skillFilePayloadSchema).max(MAX_SKILL_REFERENCE_FILES).default([]),
}).strict()

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const skills = await listCoworkerSkills(runtime, agentId)
        return Response.json({ skills }, { headers: { 'cache-control': 'no-store' } })
    })
}

export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const body = await readCoworkerSkillBody(request, MAX_SKILL_FOLDER_BYTES + 65_536)
        const parsed = skillCreateSchema.safeParse(body)
        if (parsed.success) {
            const { agentId } = await params
            const result = await createCoworkerSkill(runtime, agentId, parsed.data)
            if (!result.success || !result.skill) {
                // The desktop pre-checks the slug and the engine refuses any existing slug when
                // overwrite is off, so a name collision is a conflict, not a bad request.
                const conflict = result.error?.includes('already exists')
                throw new DesktopHttpError(conflict ? 409 : 400, result.error ?? 'Failed to create the skill.')
            }
            return Response.json({ skill: result.skill }, { status: 201 })
        }
        const imported = skillImportSchema.safeParse(body)
        if (imported.success) {
            const { agentId } = await params
            const result = await importCoworkerSkill(runtime, agentId, imported.data.content, imported.data.files)
            if (!result.success || !result.skill) {
                // The engine refuses any existing slug when overwrite is off, so a name collision
                // is a conflict, not a bad request.
                const conflict = result.error?.includes('already exists')
                throw new DesktopHttpError(conflict ? 409 : 400, result.error ?? 'Failed to import the skill.')
            }
            return Response.json({ skill: result.skill }, { status: 201 })
        }
        throw new DesktopHttpError(400, 'Send a skill to create ({ name, description, body }) or to import ({ content, files }).')
    })
}
