import { handleDesktopRepositoryTool } from '@/lib/desktop/server/repository-workspace/handler'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function POST(request: Request) {
    return handleDesktopRepositoryTool(request)
}
