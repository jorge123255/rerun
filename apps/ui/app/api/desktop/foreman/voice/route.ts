import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { desktopForemanVoice } from '@/lib/desktop/server/foreman-voice/binding'
import { foremanVoiceHandlers } from '@/lib/desktop/server/foreman-voice/api'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) { return desktopRoute(request, async runtime => {
    const app = await desktopForeman(runtime)
    return foremanVoiceHandlers(await desktopForemanVoice(runtime, app.voiceShutdownSignal)).post(request)
}) }
export async function GET(request: Request) { return desktopRoute(request, async runtime => {
    const app = await desktopForeman(runtime)
    return foremanVoiceHandlers(await desktopForemanVoice(runtime, app.voiceShutdownSignal)).audio(request)
}) }
