import 'server-only'
import { z } from 'zod'
import type { Client } from '@libsql/client'
import { desktopWebSearchInputSchema, desktopWebSearchRunIdentitySchema, desktopWebSearchOutcomeSchema, type DesktopWebSearchOutcomeStore } from '@rerun/contracts'
import { createDesktopWebSearchService } from '../../../../../engine/src/desktop/web-search/service'
import { authenticateDesktopEngineRequest } from '../auth'
import { openDesktopDatabase } from '../database'
import { getDesktopRemoteMcpService } from '../mcp-binding'
import { boundedText } from '../mcp/remote'
import { desktopAuxiliaryStore } from './store'
import { desktopAuxiliaryBackends } from './backends'

export function desktopSearchOutcomes(db: Client, owner: string): DesktopWebSearchOutcomeStore {
    const key = (identity: { agentId: string; sessionId: string; runId: string; toolCallId: string }) => JSON.stringify([identity.agentId, identity.sessionId, identity.runId, identity.toolCallId])
    return {
        async begin(identity, fingerprint) {
            const saved = await db.execute({ sql: 'INSERT INTO desktop_search_outcomes(identity,owner,fingerprint) VALUES(?,?,?) ON CONFLICT DO NOTHING', args: [key(identity), owner, fingerprint] })
            if (saved.rowsAffected === 1) return 'execute'
            const row = (await db.execute({ sql: 'SELECT fingerprint,outcome FROM desktop_search_outcomes WHERE identity=? AND owner=?', args: [key(identity), owner] })).rows[0]
            if (!row || row.fingerprint !== fingerprint) throw new Error('This search attempt has changed.')
            return row.outcome ? desktopWebSearchOutcomeSchema.parse(JSON.parse(String(row.outcome))) : { status: 'uncertain', message: 'The previous search was interrupted. It was not repeated.' }
        },
        async complete(identity, fingerprint, outcome) {
            const encoded = JSON.stringify(desktopWebSearchOutcomeSchema.parse(outcome))
            if (Buffer.byteLength(encoded) > 66_000) throw new Error('Search receipt exceeds its limit.')
            const saved = await db.execute({ sql: 'UPDATE desktop_search_outcomes SET outcome=? WHERE identity=? AND owner=? AND fingerprint=? AND outcome IS NULL', args: [encoded, key(identity), owner, fingerprint] })
            if (saved.rowsAffected === 1) return
            const row = (await db.execute({ sql: 'SELECT fingerprint,outcome FROM desktop_search_outcomes WHERE identity=? AND owner=?', args: [key(identity), owner] })).rows[0]
            if (row?.fingerprint !== fingerprint || row?.outcome !== encoded) throw new Error('The search receipt has changed.')
        },
    }
}

const inputSchema = z.object({ identity: desktopWebSearchRunIdentitySchema, input: desktopWebSearchInputSchema }).strict()
export async function handleDesktopWebSearch(request: Request) {
    const headers = { 'Cache-Control': 'no-store' }
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(17_000)])
        const body = inputSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 16_384)))
        const owner = await getDesktopRemoteMcpService(runtime), db = await openDesktopDatabase(runtime.dataRoot)
        const localOwner = await owner.authorizeRun({ engineAgentId: body.identity.agentId, sessionId: body.identity.sessionId, runId: body.identity.runId }, signal, 'webSearch')
        const credentials = desktopAuxiliaryStore(db), backend = desktopAuxiliaryBackends(credentials)
        const configured = await credentials.read('search')
        const service = createDesktopWebSearchService({
            authority: async (identity, stop) => {
                await owner.authorizeRun({ engineAgentId: identity.agentId, sessionId: identity.sessionId, runId: identity.runId }, stop, 'webSearch')
                return { adapterGeneration: (await credentials.read('search')).revision }
            },
            adapter: configured.key ? { generation: configured.revision, search: input => backend.search(input, configured.revision, input.signal) } : null,
            readiness: async () => ({ status: configured.key ? 'ready' : 'unconfigured', retryable: false, message: configured.key ? 'Brave Search key saved.' : 'Add a Brave Search key in Settings → Tool services.' }),
            outcomes: desktopSearchOutcomes(db, localOwner),
        })
        return Response.json(await service.search(body.identity, body.input, signal), { headers })
    } catch {
        return Response.json({ status: 'error', message: 'Web search is unavailable for this run.' }, { status: 400, headers })
    }
}
