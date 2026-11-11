import { readDesktopCoworkerCalls, stopDesktopCoworkerCall } from '@/lib/desktop/server/coworker-calls/http'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(request: Request, { params }: { params: Promise<{ chatId: string }> }) {
    return desktopRoute(request, async runtime => Response.json(
        await readDesktopCoworkerCalls(runtime, (await params).chatId, 'foreman'),
        { headers: { 'cache-control': 'no-store' } },
    ))
}

export function POST(request: Request, { params }: { params: Promise<{ chatId: string }> }) {
    return desktopRoute(request, async runtime =>
        stopDesktopCoworkerCall(runtime, (await params).chatId, await readDesktopJson(request, 4_096), undefined, 'foreman'))
}
