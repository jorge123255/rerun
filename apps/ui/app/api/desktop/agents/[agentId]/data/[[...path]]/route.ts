import { handleDesktopData } from '@/lib/desktop/server/coworker-data'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
type Context = { params: Promise<{ agentId: string; path?: string[] }> }

function route(request: Request, context: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId, path } = await context.params
        return handleDesktopData(runtime, request, { kind: 'agent', agentId }, path ?? [])
    })
}

/** A coworker's private database: its tables, row windows, saved views and exports. */
export function GET(request: Request, context: Context) { return route(request, context) }
export function POST(request: Request, context: Context) { return route(request, context) }
export function PUT(request: Request, context: Context) { return route(request, context) }
export function PATCH(request: Request, context: Context) { return route(request, context) }
export function DELETE(request: Request, context: Context) { return route(request, context) }
