import { handleDesktopDelegationManagement } from '@/lib/desktop/server/delegation/binding'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
async function handle(request: Request, context: { params: Promise<{ sessionId: string }> }) {
    return handleDesktopDelegationManagement(request, (await context.params).sessionId)
}
export const GET = handle
export const POST = handle
