import { desktopVoiceApi } from '@/lib/desktop/server/voice/api'
import { desktopVoiceService } from '@/lib/desktop/server/voice/binding'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

async function handle(request: Request, context: { params: Promise<{ agentId: string }> }) {
    return desktopRoute(request, async runtime => desktopVoiceApi(await desktopVoiceService(runtime))(request, (await context.params).agentId))
}

export { handle as GET, handle as POST }
