import { desktopScheduleToolNoticeRequest } from '@/lib/desktop/server/schedule-tools/notices'
export const runtime = 'nodejs'
export async function GET(request: Request, context: { params: Promise<{ agentId: string }> }) { return desktopScheduleToolNoticeRequest(request, (await context.params).agentId) }
