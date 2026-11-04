import { handleDesktopData } from '@/lib/desktop/server/coworker-data'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
type Context = { params: Promise<{ path?: string[] }> }

function route(request: Request, context: Context) {
    return desktopRoute(request, async runtime => {
        const { path } = await context.params
        return handleDesktopData(runtime, request, { kind: 'shared' }, path ?? [])
    })
}

/** The workspace shared database. It has no agent id, so a request can never name a coworker's
 *  private file through this adapter. */
export function GET(request: Request, context: Context) { return route(request, context) }
export function POST(request: Request, context: Context) { return route(request, context) }
export function PUT(request: Request, context: Context) { return route(request, context) }
export function PATCH(request: Request, context: Context) { return route(request, context) }
export function DELETE(request: Request, context: Context) { return route(request, context) }
