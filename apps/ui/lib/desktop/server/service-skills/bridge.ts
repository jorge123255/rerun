import 'server-only'
import { z } from 'zod'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'
import { boundedText } from '../mcp/remote'
import { readDesktopServiceSkillOwners } from './authority'

export async function handleDesktopServiceSkillOwners(request: Request): Promise<Response> {
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        if (request.method !== 'POST') return new Response(null, { status: 405 })
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
        const { engineAgentId } = z.object({ engineAgentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict()
            .parse(JSON.parse(await boundedText(new Response(request.body), signal, 2048)))
        const owners = await readDesktopServiceSkillOwners(runtime, engineAgentId, signal)
        if (owners.size > 2048) throw new Error('Ownership limit exceeded')
        const output = { engineAgentId, owners: [...owners].map(([slug, name]) => ({ slug, name })) }
        if (Buffer.byteLength(JSON.stringify(output)) > 262_144) throw new Error('Ownership limit exceeded')
        signal.throwIfAborted()
        return Response.json(output, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) { return Response.json({ error: 'App skill ownership unavailable' }, { status: error instanceof DesktopHttpError ? error.status : 409, headers: { 'Cache-Control': 'no-store' } }) }
}
