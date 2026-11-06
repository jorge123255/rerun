import 'server-only'
import { recallMemories } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { withCoworkerMemories } from '../memories'
import type { DesktopRuntime } from '../runtime'
import { findDesktopAgent } from '../store'
import {
    DESKTOP_SEMANTIC_DETAIL,
    desktopSemanticIndexStatusSchema,
    desktopSemanticMaintainSchema,
    desktopSemanticPanelRecall,
    desktopSemanticRecallNoteSchema,
    desktopSemanticRecallRequestSchema,
    desktopSemanticRecallResultSchema,
    type DesktopSemanticIndexStatus,
    type DesktopSemanticRecallRequest,
    type DesktopSemanticRecallResult,
} from '@rerun/contracts'
import { desktopSemanticMemoryAuthority } from './authority'
import { desktopSemanticRuntimeAuthority } from './runtime'

const unconfiguredIndex = desktopSemanticIndexStatusSchema.parse({
    mode: 'keyword-only',
    backend: null,
    indexed: 0,
    pending: 0,
    omitted: 0,
    detail: DESKTOP_SEMANTIC_DETAIL.unconfigured,
})

async function requireCoworker(runtime: DesktopRuntime, agentId: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const coworker = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
    signal?.throwIfAborted()
    if (!coworker) throw new DesktopHttpError(404, 'Coworker not found')
    return coworker.id
}

async function keywordRecall(runtime: DesktopRuntime, localAgentId: string, request: DesktopSemanticRecallRequest, signal?: AbortSignal): Promise<DesktopSemanticRecallResult> {
    signal?.throwIfAborted()
    const listed = await withCoworkerMemories(runtime, localAgentId, (engine, id) => {
        signal?.throwIfAborted()
        return recallMemories(engine, id, {
            query: request.query,
            limit: request.limit,
            includeDormant: request.includeDormant,
        })
    })
    signal?.throwIfAborted()
    const memories = listed.flatMap(memory => {
        if (!memory.id || memory.strength === undefined || !memory.status) return []
        const parsed = desktopSemanticRecallNoteSchema.safeParse({
            id: memory.id,
            content: memory.content,
            kind: memory.kind,
            tags: memory.tags,
            createdAt: memory.createdAt,
            strength: memory.strength,
            status: memory.status,
        })
        return parsed.success ? [parsed.data] : []
    })
    return desktopSemanticRecallResultSchema.parse({
        mode: 'keyword-only',
        detail: DESKTOP_SEMANTIC_DETAIL.unconfigured,
        memories: memories.slice(0, request.limit),
        index: unconfiguredIndex,
    })
}

export async function readDesktopSemanticMemory(runtime: DesktopRuntime, agentId: string, signal?: AbortSignal): Promise<DesktopSemanticIndexStatus> {
    const localAgentId = await requireCoworker(runtime, agentId, signal)
    signal?.throwIfAborted()
    const authority = desktopSemanticMemoryAuthority() ?? desktopSemanticRuntimeAuthority(runtime)
    if (!authority) return unconfiguredIndex
    const parsed = desktopSemanticIndexStatusSchema.safeParse(await authority.status(localAgentId, signal))
    signal?.throwIfAborted()
    if (!parsed.success) throw new DesktopHttpError(502, 'Semantic index status was invalid.')
    return parsed.data
}

// Panel search. reinforce is forced to none so this route cannot strengthen notes.
export async function recallDesktopSemanticMemory(runtime: DesktopRuntime, agentId: string, body: unknown, signal?: AbortSignal): Promise<DesktopSemanticRecallResult> {
    const localAgentId = await requireCoworker(runtime, agentId, signal)
    signal?.throwIfAborted()
    const parsed = desktopSemanticRecallRequestSchema.safeParse(body)
    if (!parsed.success) throw new DesktopHttpError(400, 'Enter a search query and a valid result limit.')
    const request = desktopSemanticPanelRecall(parsed.data)
    const authority = desktopSemanticMemoryAuthority() ?? desktopSemanticRuntimeAuthority(runtime)
    if (!authority) return keywordRecall(runtime, localAgentId, request, signal)
    const result = desktopSemanticRecallResultSchema.safeParse(await authority.recall(localAgentId, request, signal))
    signal?.throwIfAborted()
    if (!result.success) throw new DesktopHttpError(502, 'Semantic recall returned an invalid result.')
    return result.data
}

// Explicit derived-index maintenance. It does not create, edit, or delete canonical notes.
export async function maintainDesktopSemanticMemory(runtime: DesktopRuntime, agentId: string, body: unknown, signal?: AbortSignal): Promise<DesktopSemanticIndexStatus> {
    const localAgentId = await requireCoworker(runtime, agentId, signal)
    signal?.throwIfAborted()
    const parsed = desktopSemanticMaintainSchema.safeParse(body)
    if (!parsed.success) throw new DesktopHttpError(400, 'Unknown semantic index request.')
    const authority = desktopSemanticMemoryAuthority() ?? desktopSemanticRuntimeAuthority(runtime)
    if (!authority?.maintain) throw new DesktopHttpError(403, 'Derived index maintenance is not authorized.')
    const status = desktopSemanticIndexStatusSchema.safeParse(await authority.maintain(localAgentId, parsed.data.operation, signal))
    signal?.throwIfAborted()
    if (!status.success) throw new DesktopHttpError(502, 'Semantic index status was invalid.')
    return status.data
}
