import { createHash } from 'node:crypto'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { withAgentLock } from '../agents/lock.js'
import { HttpError } from '../lib/errors.js'
import type { RunContext } from '../runtime/context.js'
import { addDesktopMemory, reinforceDesktopMemories, removeDesktopMemory, updateDesktopMemory } from './memory-store.js'
import { recallSemanticDesktopMemory } from './semantic-memory/runtime.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from './tool-grants.js'

const noteId = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(128)
const content = z.string().trim().min(1).max(8192)

// Serialize a grant change with a write so a disabled tool cannot commit a delayed mutation.
// Memory store errors from the OS must not disclose a local path to the provider.
async function inMemoryGrant<T>(ctx: RunContext, key: 'memoryRecall' | 'memoryWrite' | 'memoryDelete', work: () => Promise<T>) {
    return withAgentLock(ctx.agent.id, async () => {
        await requireDesktopToolGrant(ctx, key)
        try { return await work() }
        catch (error) {
            if (error instanceof HttpError) throw error
            throw new Error('This coworker’s memory is unavailable.')
        }
    })
}

export function desktopMemoryTools(ctx: RunContext): ToolSet {
    const tools: ToolSet = {}
    if (hasDesktopToolGrant(ctx.agent.config, 'memoryRecall')) tools.memory_recall = tool({
        description: 'Search this coworker’s own saved memories. Returns the note ID and current text.',
        inputSchema: z.object({ query: z.string().trim().min(1).max(512), limit: z.number().int().min(1).max(20).default(5), includeDormant: z.boolean().default(false) }),
        execute: async ({ query, limit, includeDormant }) => {
            await requireDesktopToolGrant(ctx, 'memoryRecall')
            const result = await recallSemanticDesktopMemory(ctx.agent.id, { query, limit, includeDormant, reinforce: 'none' }, ctx.abortSignal)
            return inMemoryGrant(ctx, 'memoryRecall', async () => {
                await reinforceDesktopMemories(ctx.agent.id, result.memories.map(note => note.id), 'full')
                ctx.abortSignal?.throwIfAborted()
                return result.memories.map(h => `- [${h.id}] (${h.kind}) ${h.content.slice(0, 8192)}`).join('\n').slice(0, 32768) || 'No relevant memories.'
            })
        },
    })
    if (hasDesktopToolGrant(ctx.agent.config, 'memoryWrite')) tools.memory_write = tool({
        description: 'Save a note for this coworker. To update one, pass its ID and the exact previous content.',
        inputSchema: z.object({ content, kind: z.string().trim().min(1).max(64).default('note'), tags: z.array(z.string().trim().min(1).max(64)).max(32).default([]), updateId: noteId.optional(), expectedContent: content.optional() }),
        execute: args => inMemoryGrant(ctx, 'memoryWrite', async () => {
            if (args.updateId) {
                if (!args.expectedContent) throw new HttpError(400, 'Updating a note requires its previous text.')
                await updateDesktopMemory(ctx.agent.id, args.updateId, args.expectedContent, args.content)
                return `Updated memory ${args.updateId}`
            }
            if (args.expectedContent) throw new HttpError(400, 'An update requires the note ID.')
            const requestId = createHash('sha256').update(JSON.stringify([ctx.runId, args.content, args.kind, args.tags])).digest('hex').slice(0, 32)
            const id = await addDesktopMemory(ctx.agent.id, { ...args, requestId })
            return `Saved memory ${id}`
        }),
    })
    if (hasDesktopToolGrant(ctx.agent.config, 'memoryDelete')) tools.memory_delete = tool({
        description: 'Delete one of this coworker’s notes using its ID and exact previous content.',
        inputSchema: z.object({ id: noteId, expectedContent: content }),
        execute: ({ id, expectedContent }) => inMemoryGrant(ctx, 'memoryDelete', async () => {
            await removeDesktopMemory(ctx.agent.id, id, expectedContent)
            return `Deleted memory ${id}`
        }),
    })
    return tools
}
