import { interceptDesktopWebhookDecision, recoverDesktopWebhookSecret } from '@/lib/desktop/server/trigger-requests/binding'
import { createDesktopSecretRequestApi } from '@/lib/desktop/server/secret-requests/api'
import { desktopSecretRequestPorts } from '@/lib/desktop/server/secret-requests/binding'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
    return desktopRoute(request, async runtime => createDesktopSecretRequestApi(desktopSecretRequestPorts(runtime, (await params).sessionId)).GET(request, (await params).sessionId))
}

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
    return desktopRoute(request, async runtime => {
        const sessionId = (await params).sessionId, ports = desktopSecretRequestPorts(runtime, sessionId)
        return createDesktopSecretRequestApi({ ...ports, recover: (id,input,signal) => recoverDesktopWebhookSecret(runtime,id,input,signal), decide: async (id, input, signal) =>
            await interceptDesktopWebhookDecision(runtime, id, { kind: 'secret', input }) ?? ports.decide(id, input, signal),
        }).POST(request, sessionId)
    })
}
