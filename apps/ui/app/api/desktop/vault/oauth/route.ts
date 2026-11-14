import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { getDesktopRemoteMcpService } from '@/lib/desktop/server/mcp-binding'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

export const dynamic = 'force-dynamic'

const schema = z.strictObject({
    id: z.uuid(), name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), revision: z.uuid(),
    action: z.enum(['start', 'status', 'cancel']),
})

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        assertDesktopWorkspaceAdmission(runtime)
        const input = schema.safeParse(await readDesktopJson(request, 4096))
        if (!input.success) throw new DesktopHttpError(400, 'Invalid Vault sign-in request.')
        const { id, name, revision, action } = input.data
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        const { vaultOAuth } = await getDesktopRemoteMcpService(runtime)
        signal.throwIfAborted()
        const headers = { 'cache-control': 'no-store' }
        try {
            if (action === 'start') return Response.json(await vaultOAuth.start(id, name, revision, signal), { headers })
            if (action === 'status') return Response.json(await vaultOAuth.status(id, name, revision, signal), { headers })
            await vaultOAuth.cancel(id, name, revision, signal)
            return Response.json({ state: 'idle' }, { headers })
        } catch {
            return Response.json({ state: 'error', message: 'Vault sign-in is unavailable. Refresh the entry and retry.' }, { status: 409, headers })
        }
    })
}
