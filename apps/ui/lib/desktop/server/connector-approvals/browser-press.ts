import 'server-only'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { desktopBrowserPressSchema } from '@rerun/contracts'
import { authenticateDesktopEngineRequest } from '../auth'
import { openDesktopDatabase } from '../database'
import { getDesktopRemoteMcpService } from '../mcp-binding'
import { boundedText } from '../mcp/remote'
import { admitBrowserPress } from './store'

const inputSchema = z.object({
    identity: z.object({ engineAgentId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), runId: z.string().min(1).max(200) }).strict(),
    press: desktopBrowserPressSchema,
}).strict()

export type BrowserPressPorts = {
    /** Proves the request comes from this coworker's run that is going on right now, with the browser and the screen granted. Returns its local id. */
    authorize(run: { engineAgentId: string; sessionId: string; runId: string }, signal: AbortSignal): Promise<string>
    db(): Promise<Client>
}

/**
 * The engine asks here before a coworker presses a button in its browser that sends, posts, pays,
 * deletes or changes a credential. `{ ok: true }` means the person allowed exactly this press and
 * the allowance is now spent. Anything else is what the coworker is told; the press is not made.
 *
 * The label and the host are page content. They are kept for the card and are never put into the
 * text the coworker reads.
 */
export async function handleDesktopBrowserPress(request: Request, ports?: BrowserPressPorts): Promise<Response> {
    const headers = { 'Cache-Control': 'no-store' }
    try {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25_000)])
        let wired = ports
        if (!wired) {
            const runtime = await authenticateDesktopEngineRequest(request)
            const owner = await getDesktopRemoteMcpService(runtime)
            wired = {
                async authorize(run, stop) {
                    let localId = ''
                    for (const grant of ['computer', 'browser'] as const) localId = await owner.authorizeRun(run, stop, grant)
                    return localId
                },
                db: () => openDesktopDatabase(runtime.dataRoot),
            }
        }
        const body = inputSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 4096)))
        const owner = await wired.authorize(body.identity, signal)
        const held = await admitBrowserPress(await wired.db(), { owner, sessionId: body.identity.sessionId, press: body.press })
        return Response.json(held === null ? { ok: true } : { ok: false, reason: held }, { headers })
    } catch {
        return Response.json({ ok: false, reason: 'Rerun could not ask the person about this press, so nothing was pressed. Tell them, and try again later.' }, { headers })
    }
}
