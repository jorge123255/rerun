import { handleDesktopTypeSecret } from '@/lib/desktop/server/screen-secret/typing'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function POST(request: Request) {
    return handleDesktopTypeSecret(request)
}
