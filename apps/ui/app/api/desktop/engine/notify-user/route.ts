import { desktopNotifyUserAdmissionSchema } from '../../../../../../engine/src/desktop/notify-tools/contract'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { acceptDesktopUserNotification, desktopNotifyRunIsCurrent, readDesktopNotifyGrant } from '@/lib/desktop/server/user-notifications'

export const dynamic = 'force-dynamic'

const headers = { 'cache-control': 'no-store' }

export async function POST(request: Request): Promise<Response> {
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        const parsed = desktopNotifyUserAdmissionSchema.safeParse(await readDesktopJson(request, 200_000))
        if (!parsed.success) throw new DesktopHttpError(400, 'Notification identity is unavailable.')
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(14_000)])
        const receipt = await acceptDesktopUserNotification(await openDesktopDatabase(runtime.dataRoot), runtime, parsed.data, signal, {
            grant: (agentId, grantSignal) => readDesktopNotifyGrant(runtime, agentId, grantSignal),
            run: (input, runSignal) => desktopNotifyRunIsCurrent(runtime, input, runSignal),
        })
        return Response.json(receipt, { headers })
    } catch (error) {
        if (error instanceof DesktopHttpError) return Response.json({ error: error.message }, { status: error.status, headers })
        return Response.json({ error: 'Desktop callback failed' }, { status: 500, headers })
    }
}
