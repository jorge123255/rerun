import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopVoiceEngine } from '@/lib/desktop/server/voice-engine/binding'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        await openDesktopDatabase(runtime.dataRoot)
        // The app asks this when it starts: a phone voice relay the owner turned on reconnects then.
        await desktopVoiceEngine(runtime).catch(() => {})
        return Response.json({
            protocolVersion: 1,
            launchNonce: runtime.launchNonce,
            buildId: runtime.buildId,
            workspaceId: runtime.workspaceId,
            status: 'ready',
        })
    })
}
