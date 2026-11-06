import 'server-only'
import { z } from 'zod'
import type { ExternalMcpCallContext, ExternalMcpLiveCheckInput, ExternalMcpLiveCheckResult } from '@rerun/contracts'
import { ACCOUNT_TOOL_DEFS } from '@/lib/mcp/account-tools'
import { createExternalReadDispatch } from '../../../../../engine/src/desktop/external-mcp-tools/dispatch'
import { openDesktopDatabase } from '../database'
import { readDesktopRuntime, type DesktopRuntime } from '../runtime'
import { findDesktopAgent, listDesktopAgents } from '../store'
import { listCoworkerSkills, getCoworkerSkill, readCoworkerSkillFile } from '../coworker-skills'
import { listRuns } from '@/lib/engine/client'
import { engineOf } from '../settings'
import { desktopRunView } from '../../run-history'

const id = z.string().min(1).max(256)
const schemas = {
    list_agents: z.strictObject({ spaceId: id.optional() }),
    list_skills: z.strictObject({ agentId: id }),
    get_skill: z.strictObject({ agentId: id, slug: id }),
    read_skill_file: z.strictObject({ agentId: id, slug: id, path: z.string().min(1).max(1024), offset: z.literal(0).optional() }),
    list_runs: z.strictObject({ agentId: id, limit: z.number().int().min(1).max(200).optional() }),
}
export function createLocalExternalReadTools(recheck: (input: ExternalMcpLiveCheckInput) => Promise<ExternalMcpLiveCheckResult>) {
    async function checkpoint(context: ExternalMcpCallContext, signal: AbortSignal) {
        signal.throwIfAborted()
        const p = context.principal
        if (!p.scopes.includes('mcp:read')) throw new Error('Read scope is required.')
        const result = await recheck({ keyId: p.keyId, workspaceId: p.workspaceId, keyRevision: p.keyRevision, installId: p.installId, launchNonce: p.launchNonce, requestId: context.requestId, scopes: [...p.scopes] })
        signal.throwIfAborted()
        if (!result.ok) throw new Error('External authority changed.')
    }
    async function guarded<T>(c: ExternalMcpCallContext, signal: AbortSignal, action: () => Promise<T>) {
        await checkpoint(c, signal)
        const result = await action()
        await checkpoint(c, signal)
        return result
    }
    return createExternalReadDispatch({ recheck,
        tools: ACCOUNT_TOOL_DEFS.filter(tool => Object.hasOwn(schemas, tool.name)).map(tool => ({ ...tool, description: tool.name === 'read_skill_file' ? tool.description + ' Local adapter accepts offset 0 only.' : tool.description, inputSchema: { ...tool.inputSchema, ...(tool.name === 'read_skill_file' ? { properties: { ...tool.inputSchema.properties, offset: { type: 'integer', const: 0 } } } : {}), additionalProperties: false }, scope: 'mcp:read', effect: false })),
        async read(c, signal) {
            if (!Object.hasOwn(schemas, c.tool)) throw new Error('Unsupported external tool.')
            const schema = schemas[c.tool as keyof typeof schemas]
            const args = schema.parse(c.arguments)
            const runtime: DesktopRuntime = await guarded(c, signal, () => readDesktopRuntime())
            if (runtime.workspaceId !== c.principal.workspaceId || runtime.launchNonce !== c.principal.launchNonce) throw new Error('Workspace runtime is not bound to this key.')
            const db = await guarded(c, signal, () => openDesktopDatabase(runtime.dataRoot))
            if (c.tool === 'list_agents') {
                const rows = await guarded(c, signal, () => listDesktopAgents(db))
                const spaceId = 'spaceId' in args ? args.spaceId : undefined
                const owned = rows.filter(row => row.workspaceId === c.principal.workspaceId && (!spaceId || row.spaceId === spaceId))
                if (owned.length > 200) throw new Error('Too many coworkers. Narrow by Box.')
                return { agents: owned.map(row => ({ id: row.id, name: row.name, description: row.description, spaceId: row.spaceId ?? null, enabled: row.enabled })) }
            }
            if (!('agentId' in args)) throw new Error('Coworker identity is required.')
            const agent = await guarded(c, signal, () => findDesktopAgent(db, args.agentId))
            if (!agent || agent.workspaceId !== c.principal.workspaceId) throw new Error('Coworker not found.')
            if (c.tool === 'list_skills') {
                const skills = await guarded(c, signal, () => listCoworkerSkills(runtime, agent.id))
                if (skills.length > 200) throw new Error('Too many skills for one external response.')
                return { skills: skills.map(skill => ({ slug: skill.slug, name: skill.name, description: skill.description })) }
            }
            if (c.tool === 'get_skill' && 'slug' in args) {
                const skill = await guarded(c, signal, () => getCoworkerSkill(runtime, agent.id, args.slug))
                if (!skill) throw new Error('Skill not found.')
                return { slug: skill.slug, name: skill.name, description: skill.description, body: skill.body, files: skill.files }
            }
            if (c.tool === 'read_skill_file' && 'path' in args) {
                const file = await guarded(c, signal, () => readCoworkerSkillFile(runtime, agent.id, args.slug, args.path))
                if (!file) throw new Error('Skill file not found.')
                return { slug: args.slug, ...file }
            }
            if (c.tool === 'list_runs') {
                const runs = await guarded(c, signal, () => listRuns(engineOf(runtime), agent.engineAgentId, { limit: 'limit' in args ? args.limit ?? 20 : 20 }, { signal }))
                if (runs.some(run => run.agentId !== agent.engineAgentId)) throw new Error('Run identity mismatch.')
                return { runs: runs.map(desktopRunView) }
            }
            throw new Error('Unsupported external tool.')
        },
    })
}
