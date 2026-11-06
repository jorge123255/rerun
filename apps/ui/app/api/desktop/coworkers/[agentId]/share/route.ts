import { openDesktopCoworkerShareBinding } from '@/lib/desktop/server/coworker-share/binding'
import { desktopRoute } from '@/lib/desktop/server/http'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { ZodError } from 'zod'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
type Context = { params: Promise<{ agentId: string }> }
async function handle(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const binding = await openDesktopCoworkerShareBinding(runtime,agentId)
        try { return await binding.api[request.method === 'GET' ? 'GET' : 'POST'](request) }
        catch (error) { if (error instanceof ZodError) throw new DesktopHttpError(400,'Invalid coworker share request.'); throw error }
    })
}
export const GET = handle
export const POST = handle
