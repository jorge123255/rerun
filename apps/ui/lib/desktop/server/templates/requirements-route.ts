import 'server-only'
import { z } from 'zod'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { boundedText } from '../mcp/remote'
import { readDesktopPortableSetupRequirements } from './requirements'

export async function handleDesktopTemplateRequirements(request: Request) {
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
        const input = z.strictObject({ engineAgentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).parse(JSON.parse(await boundedText(new Response(request.body), signal, 4096)))
        const db = await openDesktopDatabase(runtime.dataRoot)
        const owner = async (id: string) => {
            const rows = (await db.execute({ sql: 'SELECT id FROM desktop_agents WHERE workspace_id=1 AND engine_agent_id=?', args: [id] })).rows
            if (rows.length !== 1) throw new DesktopHttpError(409, 'Template requirement owner changed')
            const localId = String(rows[0]!.id); await assertCoworkerNotDeleting(db, localId); signal.throwIfAborted()
            return localId
        }
        const original = await owner(input.engineAgentId)
        const requirements = await readDesktopPortableSetupRequirements(db, { id: original, engineAgentId: input.engineAgentId })
        if (original !== await owner(input.engineAgentId)) throw new DesktopHttpError(409, 'Template requirement owner changed')
        return Response.json({ engineAgentId: input.engineAgentId, requirements }, { headers: { 'Cache-Control': 'no-store' } })
    } catch { return Response.json({ error: 'Could not verify template requirement names.' }, { status: 409 }) }
}
