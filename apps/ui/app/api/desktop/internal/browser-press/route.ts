import { handleDesktopBrowserPress } from '@/lib/desktop/server/connector-approvals/browser-press'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function POST(request: Request) {
    return handleDesktopBrowserPress(request)
}
