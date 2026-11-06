import { createDesktopSecretRequestApi } from '@/lib/desktop/server/secret-requests/api'
import { desktopSecretRequestPorts } from '@/lib/desktop/server/secret-requests/binding'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
    return desktopRoute(request, async runtime => createDesktopSecretRequestApi(desktopSecretRequestPorts(runtime, (await params).sessionId)).GET(request, (await params).sessionId))
}

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
    return desktopRoute(request, async runtime => createDesktopSecretRequestApi(desktopSecretRequestPorts(runtime, (await params).sessionId)).POST(request, (await params).sessionId))
}
