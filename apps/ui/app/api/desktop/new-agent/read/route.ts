import { z } from 'zod'
import { desktopRoute } from '@/lib/desktop/server/http'
import { boundedText } from '@/lib/desktop/server/mcp/remote'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const input = z.object({ text: z.string().trim().min(1).max(2000) }).strict()
const output = z.object({ reply: z.string().max(8000) }).strict()
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(6000)])
        try {
            const body = input.parse(JSON.parse(await boundedText(new Response(request.body), signal, 32_768)))
            const response = await fetch(`${runtime.engine.origin}/desktop/new-agent/read`, {
                method: 'POST', headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body), signal, redirect: 'error',
            })
            if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('Reading unavailable') }
            return Response.json(output.parse(JSON.parse(await boundedText(response, signal, 65_536))), { headers: { 'Cache-Control': 'no-store' } })
        } catch {
            // Rerun's original reader is optional: the user can always name the coworker, and
            // a missing provider or timeout supplies no invented inference.
            return Response.json({ reply: '' }, { headers: { 'Cache-Control': 'no-store' } })
        }
    })
}
