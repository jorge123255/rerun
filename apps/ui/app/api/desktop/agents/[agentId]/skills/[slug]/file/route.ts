import { z } from 'zod'
import { MAX_SKILL_FILE_BYTES } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { deleteCoworkerSkillFile, readCoworkerSkillFile, writeCoworkerSkillFile } from '@/lib/desktop/server/coworker-skills'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readCoworkerSkillBody } from '@/lib/desktop/server/coworker-skill-body'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string; slug: string }> }

function pathOf(url: URL): string {
    const raw = url.searchParams.get('path') ?? ''
    if (raw.length > 4096) throw new DesktopHttpError(400, 'The skill file path is too long.')
    // Normalize like the store does: drop empty and "." segments, so "./references/x.md" and
    // "references//x.md" address the same file as "references/x.md".
    const path = raw.split('/').filter(part => part && part !== '.').join('/')
    // The manifest is the top-level SKILL.md the engine owns; on a case-insensitive APFS any case
    // variant is the same file, so a top-level read or delete that could name it is refused.
    if (!path || path.toUpperCase() === 'SKILL.MD') throw new DesktopHttpError(400, 'Send a file path other than SKILL.md.')
    return path
}

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId, slug } = await params
        if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw new DesktopHttpError(400, 'Invalid skill slug.')
        const content = await readCoworkerSkillFile(runtime, agentId, slug, pathOf(new URL(request.url)))
        if (!content) throw new DesktopHttpError(404, 'Skill file not found.')
        return Response.json(content, { headers: { 'cache-control': 'no-store' } })
    })
}

const skillFileWriteSchema = z.object({
    path: z.string().min(1).max(4096),
    content: z.string(),
    createOnly: z.boolean().optional(),
    baseIdentity: z.string().min(1).max(512).optional(),
    completeRead: z.boolean().optional(),
}).strict().refine(value => value.createOnly === true || (value.completeRead === true && !!value.baseIdentity))

export function PUT(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const body = skillFileWriteSchema.safeParse(await readCoworkerSkillBody(request, MAX_SKILL_FILE_BYTES + 65_536))
        if (!body.success) throw new DesktopHttpError(400, 'Send a path and content to save.')
        const { agentId, slug } = await params
        if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw new DesktopHttpError(400, 'Invalid skill slug.')
        const result = await writeCoworkerSkillFile(runtime, agentId, slug, body.data.path, body.data.content, {
            createOnly: body.data.createOnly,
            baseIdentity: body.data.baseIdentity,
            completeRead: body.data.completeRead,
        })
        if (!result.success) {
            const conflict = result.error?.includes('already exists') || result.error?.includes('changed') || result.error?.includes('partly read')
            throw new DesktopHttpError(conflict ? 409 : 400, result.error ?? 'Failed to save the file.')
        }
        return Response.json({ ok: true })
    })
}

export function DELETE(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId, slug } = await params
        if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw new DesktopHttpError(400, 'Invalid skill slug.')
        const result = await deleteCoworkerSkillFile(runtime, agentId, slug, pathOf(new URL(request.url)))
        if (!result.success) throw new DesktopHttpError(400, result.error ?? 'Failed to delete the file.')
        return new Response(null, { status: 204 })
    })
}
