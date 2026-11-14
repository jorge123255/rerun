import { createDesktopMcpDeviceReviewApi } from '@/lib/desktop/server/mcp-device-approval/api'
import { getDesktopRemoteMcpService } from '@/lib/desktop/server/mcp-binding'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const handle = createDesktopMcpDeviceReviewApi(async runtime => (await getDesktopRemoteMcpService(runtime)).deviceReview)

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
    return handle(request, (await context.params).sessionId)
}
