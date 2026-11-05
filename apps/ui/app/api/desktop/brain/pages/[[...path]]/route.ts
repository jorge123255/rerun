import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopBrainPagesRequest } from '@/lib/desktop/server/brain-pages'

export const runtime = 'nodejs'
type Context = { params: Promise<{ path?: string[] }> }
async function handle(request: Request, context: Context) {
    const response = await desktopRoute(request, async runtime => desktopBrainPagesRequest(runtime, request, (await context.params).path ?? []))
    response.headers.set('Cache-Control', 'no-store')
    return response
}
export const GET = handle
export const PUT = handle
export const DELETE = handle
export const POST = handle
