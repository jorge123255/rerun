import { Hono } from 'hono'
import { z } from 'zod'
import { getAgent } from '../../agents/registry.js'
import { listMemoryFiles } from '../../memory/files.js'
import { recallMemory, writeMemory, deleteMemory, deleteAllMemories } from '../../memory/store.js'
import { computeStrength, memoryStatus } from '../../memory/decay.js'
import { listMemories } from '../../db/repos/memories.js'
import { desktopApp } from '../../desktop/policy.js'
import { desktopMemoryPaths } from '../../desktop/memory-paths.js'

export const memoryRoutes = new Hono()

memoryRoutes.get('/', async c => {
    const agentId = c.req.param('id')!
    const desktop = desktopApp() ? await desktopMemoryPaths(agentId) : undefined
    const [files, rows] = await Promise.all([
        listMemoryFiles(agentId, desktop?.memory),
        desktop && !desktop.hasIndex ? [] : listMemories(agentId).catch(() => []),
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
    const agent = await getAgent(agentId)
    const body = z.object({ content: z.string().min(1), kind: z.string().default('note'), tags: z.array(z.string()).default([]) }).parse(await c.req.json())
    const id = await writeMemory(agent, body.content, body.kind, body.tags)
    return c.json({ id }, 201)
})

memoryRoutes.post('/recall', async c => {
    const agentId = c.req.param('id')!
    const agent = await getAgent(agentId)
    const body = z.object({ query: z.string().min(1), limit: z.number().int().positive().max(20).default(5), includeDormant: z.boolean().default(false) }).parse(await c.req.json())
    const memories = await recallMemory(agent, body.query, body.limit, { includeDormant: body.includeDormant, reinforce: 'none' })
    return c.json({ memories: memories.map(m => ({ ...m, status: memoryStatus(m.strength) })) })
})

memoryRoutes.delete('/', async c => {
    const agent = await getAgent(c.req.param('id')!)
    await deleteAllMemories(agent)
    return c.body(null, 204)
})

memoryRoutes.delete('/:memoryId', async c => {
    const agent = await getAgent(c.req.param('id')!)
    await deleteMemory(agent, c.req.param('memoryId')!)
    return c.body(null, 204)
})
