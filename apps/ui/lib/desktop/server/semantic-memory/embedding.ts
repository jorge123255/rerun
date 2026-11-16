import 'server-only'
import { z } from 'zod'
import { authenticateDesktopEngineRequest } from '../auth'
import { openDesktopDatabase } from '../database'
import { boundedText } from '../mcp/remote'
import { desktopAuxiliaryStore } from '../auxiliary/store'
import { DESKTOP_EMBEDDING_IDENTITY, desktopAuxiliaryBackends } from '../auxiliary/backends'
import { desktopLocalEmbeddingIdentity, embedDesktopLocally } from '../auxiliary/local-embedding'

const owner = { engineAgentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }
const inputSchema = z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('configuration'), ...owner }),
    z.strictObject({ operation: z.literal('embed'), ...owner, revision: z.uuid(), texts: z.array(z.string().min(1).max(8192)).min(1).max(16) }),
])

export async function handleDesktopMemoryEmbedding(request: Request) {
    const headers = { 'Cache-Control': 'no-store' }
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        // A model on this Mac may have to load before its first answer, so it is given longer than a hosted one.
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)])
        const input = inputSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 200_000)))
        const db = await openDesktopDatabase(runtime.dataRoot)
        async function requireOwner() {
            signal.throwIfAborted()
            const rows = await db.execute({ sql: `SELECT a.id,a.enabled FROM desktop_agents a
                WHERE a.workspace_id=1 AND a.engine_agent_id=?
                AND NOT EXISTS(SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)`, args: [input.engineAgentId] })
            signal.throwIfAborted()
            if (rows.rows.length !== 1) throw new Error('Coworker is unavailable')
            return { id: String(rows.rows[0]!.id), enabled: Number(rows.rows[0]!.enabled) !== 0 }
        }
        const before = await requireOwner(), credentials = desktopAuxiliaryStore(db)
        // OpenRouter when it has a key; else the model named for this Mac's Ollama. The hosted key is
        // never read here: only the local setting, which is a model name, is.
        const saved = await credentials.list()
        const hosted = saved.find(value => value.purpose === 'embedding')!
        const onMac = saved.find(value => value.purpose === 'local-embedding')
        const local = !hosted.configured && !!onMac?.configured
        const configuration = local ? onMac! : hosted
        const localModel = async () => {
            const setting = await credentials.read('local-embedding')
            if (!setting.key || setting.revision !== configuration.revision) throw new Error('Embedding configuration changed')
            return setting.key
        }
        if (input.operation === 'configuration') {
            const after = await requireOwner()
            if (after.id !== before.id) throw new Error('Coworker changed')
            // A local model that cannot answer now (Ollama closed, model not pulled) reads as not set up.
            const identity = !after.enabled || !configuration.configured ? null
                : local ? await localModel().then(model => desktopLocalEmbeddingIdentity(model, configuration.revision, signal)).catch(() => null) : DESKTOP_EMBEDDING_IDENTITY
            return Response.json({ identity, revision: configuration.revision }, { headers })
        }
        if (!before.enabled || !configuration.configured || configuration.revision !== input.revision) throw new Error('Embedding configuration changed')
        const vectors = local ? await embedDesktopLocally(await localModel(), input.texts, signal) : await desktopAuxiliaryBackends(credentials).embed(input.texts, signal, input.revision)
        if (local) await localModel()
        const after = await requireOwner()
        if (after.id !== before.id || !after.enabled) throw new Error('Coworker changed')
        return Response.json({ vectors }, { headers })
    } catch {
        return Response.json({ error: 'Memory indexing is unavailable.' }, { status: 400, headers })
    }
}
