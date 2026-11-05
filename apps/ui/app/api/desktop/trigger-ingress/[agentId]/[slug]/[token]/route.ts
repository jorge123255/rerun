import { desktopLocalTriggerIngress } from '@/lib/desktop/server/triggers/ingress'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string; slug: string; token: string }> }
async function handle(request: Request, context: Context) { return desktopLocalTriggerIngress(request, await context.params) }
export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const HEAD = handle
export const OPTIONS = handle
