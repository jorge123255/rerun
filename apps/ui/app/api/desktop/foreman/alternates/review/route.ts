import { foremanAlternateBrowserRequestSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { bindForemanAlternates, recoverForemanAlternate, reviewForemanAlternate } from '@/lib/desktop/server/foreman-alternates/binding'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'

export const runtime = 'nodejs'

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = foremanAlternateBrowserRequestSchema.safeParse(await readDesktopJson(request, 4096))
        if (!parsed.success) throw new DesktopHttpError(400, 'Invalid Chief of Staff retry request.')
        const input = parsed.data
        const headers = { 'cache-control': 'no-store' }
        if (input.action === 'recover') {
            const receipt = await recoverForemanAlternate(runtime, input.chat, input.requestId, request.signal)
            return Response.json({ requestId: receipt.input.requestId, status: receipt.state === 'ready' ? 'prepared' : 'uncertain' }, { headers })
        }
        const source = await reviewForemanAlternate(runtime, input, request.signal)
        if (input.action === 'review') return Response.json({ ok: true }, { headers })
        const binding = await bindForemanAlternates(runtime, request.signal)
        const receipt = await binding.request({ ...input.chat, messageId: input.messageId,
            requestId: input.requestId, transcriptRevision: source.transcriptRevision })
        return Response.json({ requestId: receipt.input.requestId, status: receipt.state === 'ready' ? 'prepared' : 'uncertain' }, { headers })
    })
}
