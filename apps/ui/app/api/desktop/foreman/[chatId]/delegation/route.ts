import { handleDesktopDelegationManagement } from '@/lib/desktop/server/delegation/binding'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function handle(request: Request, context: { params: Promise<{ chatId: string }> }) {
    const { chatId } = await context.params
    return handleDesktopDelegationManagement(request, chatId, 'foreman')
}

export { handle as GET, handle as POST }
