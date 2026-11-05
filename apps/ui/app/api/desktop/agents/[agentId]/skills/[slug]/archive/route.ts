import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { downloadCoworkerSkillArchive } from '@/lib/desktop/server/coworker-skills'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string; slug: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId, slug } = await params
        if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw new DesktopHttpError(400, 'Invalid skill slug.')
        const result = await downloadCoworkerSkillArchive(runtime, agentId, slug)
        if (!result.success || !result.base64) throw new DesktopHttpError(400, result.error ?? 'Failed to download the skill.')
        return Response.json({ base64: result.base64 })
    })
}
