import { Hono } from 'hono'
import { desktopMemoryCreateSchema, memoryRecallQuerySchema } from '@rerun/contracts'
import { z } from 'zod'
import { getAgent } from '../../agents/registry.js'
import { listMemoryFiles } from '../../memory/files.js'
import { recallMemory, writeMemory, deleteMemory, deleteAllMemories } from '../../memory/store.js'
import { computeStrength, memoryStatus } from '../../memory/decay.js'
import { listMemories } from '../../db/repos/memories.js'
import { desktopApp } from '../../desktop/policy.js'
import { addDesktopMemory, listDesktopMemory, recallDesktopMemory, removeDesktopMemory } from '../../desktop/memory-store.js'

export const memoryRoutes = new Hono()

memoryRoutes.get('/', async c => {
    const agentId = c.req.param('id')!
    const [files, rows] = desktopApp() ? await listDesktopMemory(agentId) : await Promise.all([
        listMemoryFiles(agentId), listMemories(agentId).catch(() => []),
    ])
    const statsById = new Map(rows.map(r => [r.id, r]))
    return c.json({
        memories: files.map(f => {
            const stats = statsById.get(f.id) ?? { kind: f.kind, createdAt: f.createdAt, lastAccessedAt: null, accessCount: 0 }
            const strength = computeStrength(stats)
            return {
                id: f.id,
                kind: f.kind,
                tags: f.tags,
                createdAt: f.createdAt,
                content: f.content,
                lastAccessedAt: stats.lastAccessedAt,
                accessCount: stats.accessCount,
                strength,
                status: memoryStatus(strength),
            }
        }),
    })
})

memoryRoutes.post('/', async c => {
    const agentId = c.req.param('id')!
    if (desktopApp()) {
        const body = desktopMemoryCreateSchema.parse(await c.req.json().catch(() => null))
        return c.json({ id: await addDesktopMemory(agentId, body) }, 201)
    }
    const agent = await getAgent(agentId)
    const body = z.object({ content: z.string().min(1), kind: z.string().default('note'), tags: z.array(z.string()).default([]) }).parse(await c.req.json())
    const id = await writeMemory(agent, body.content, body.kind, body.tags)
    return c.json({ id }, 201)
})

memoryRoutes.post('/recall', async c => {
    const agentId = c.req.param('id')!
    const desktop = desktopApp()
    const body = desktop
        ? memoryRecallQuerySchema.parse(await c.req.json().catch(() => null))
        : z.object({ query: z.string().min(1), limit: z.number().int().positive().max(20).default(5), includeDormant: z.boolean().default(false) }).parse(await c.req.json())
    const memories = desktop
        ? await recallDesktopMemory(agentId, body.query, body.limit, { includeDormant: body.includeDormant })
        : await recallMemory(await getAgent(agentId), body.query, body.limit, { includeDormant: body.includeDormant, reinforce: 'none' })
    return c.json({ memories: memories.map(m => ({ ...m, status: memoryStatus(m.strength) })) })
})

memoryRoutes.delete('/', async c => {
    const agent = await getAgent(c.req.param('id')!)
    await deleteAllMemories(agent)
    return c.body(null, 204)
})

memoryRoutes.delete('/:memoryId', async c => {
    if (desktopApp()) {
        await removeDesktopMemory(c.req.param('id')!, c.req.param('memoryId')!)
        return c.body(null, 204)
    }
    const agent = await getAgent(c.req.param('id')!)
    await deleteMemory(agent, c.req.param('memoryId')!)
    return c.body(null, 204)
})
