import { createTriggerRequestsApi } from '@/lib/desktop/server/trigger-requests/api'
import { openDesktopTriggerRequests } from '@/lib/desktop/server/trigger-requests/binding'
export const dynamic = 'force-dynamic'
const api = createTriggerRequestsApi(openDesktopTriggerRequests)
type Params = { params: Promise<{ sessionId: string }> }
export async function GET(request: Request, { params }: Params) { return api.GET(request, (await params).sessionId) }
export async function POST(request: Request, { params }: Params) { return api.POST(request, (await params).sessionId) }
