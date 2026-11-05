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
} from '../../../../../../packages/contracts/src/desktop-semantic-memory.ts'
import { desktopSemanticMemoryAuthority } from './authority'

const unconfiguredIndex = desktopSemanticIndexStatusSchema.parse({
    mode: 'keyword-only',
    backend: null,
    indexed: 0,
    pending: 0,
    omitted: 0,
    detail: DESKTOP_SEMANTIC_DETAIL.unconfigured,
})

async function requireCoworker(runtime: DesktopRuntime, agentId: string): Promise<string> {
    const coworker = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
    if (!coworker) throw new DesktopHttpError(404, 'Coworker not found')
    return coworker.id
}

async function keywordRecall(runtime: DesktopRuntime, localAgentId: string, request: DesktopSemanticRecallRequest): Promise<DesktopSemanticRecallResult> {
    const listed = await withCoworkerMemories(runtime, localAgentId, (engine, id) => recallMemories(engine, id, {
        query: request.query,
        limit: request.limit,
        includeDormant: request.includeDormant,
    }))
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

export async function readDesktopSemanticMemory(runtime: DesktopRuntime, agentId: string): Promise<DesktopSemanticIndexStatus> {
    const localAgentId = await requireCoworker(runtime, agentId)
    const authority = desktopSemanticMemoryAuthority()
    if (!authority) return unconfiguredIndex
    const parsed = desktopSemanticIndexStatusSchema.safeParse(await authority.status(localAgentId))
    if (!parsed.success) throw new DesktopHttpError(502, 'Semantic index status was invalid.')
    return parsed.data
}

// Panel search. reinforce is forced to none so this route cannot strengthen notes.
export async function recallDesktopSemanticMemory(runtime: DesktopRuntime, agentId: string, body: unknown): Promise<DesktopSemanticRecallResult> {
    const localAgentId = await requireCoworker(runtime, agentId)
    const parsed = desktopSemanticRecallRequestSchema.safeParse(body)
    if (!parsed.success) throw new DesktopHttpError(400, 'Enter a search query and a valid result limit.')
    const request = desktopSemanticPanelRecall(parsed.data)
    const authority = desktopSemanticMemoryAuthority()
    if (!authority) return keywordRecall(runtime, localAgentId, request)
    const result = desktopSemanticRecallResultSchema.safeParse(await authority.recall(localAgentId, request))
    if (!result.success) throw new DesktopHttpError(502, 'Semantic recall returned an invalid result.')
    return result.data
}

// Explicit derived-index maintenance. It does not create, edit, or delete canonical notes.
export async function maintainDesktopSemanticMemory(runtime: DesktopRuntime, agentId: string, body: unknown): Promise<DesktopSemanticIndexStatus> {
    const localAgentId = await requireCoworker(runtime, agentId)
    const parsed = desktopSemanticMaintainSchema.safeParse(body)
    if (!parsed.success) throw new DesktopHttpError(400, 'Unknown semantic index request.')
    const authority = desktopSemanticMemoryAuthority()
    if (!authority?.maintain) throw new DesktopHttpError(403, 'Derived index maintenance is not authorized.')
    const status = desktopSemanticIndexStatusSchema.safeParse(await authority.maintain(localAgentId, parsed.data.operation))
    if (!status.success) throw new DesktopHttpError(502, 'Semantic index status was invalid.')
    return status.data
}
