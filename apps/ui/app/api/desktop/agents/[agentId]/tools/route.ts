import { desktopCodexGrantsOf, desktopRerunGrantsOf, type AgentConfig } from '@rerun/contracts'
import { coworkerToolCatalogs, coworkerToolPatch, type CoworkerToolPatch } from '@/lib/desktop/coworker-tools'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { engineOf } from '@/lib/desktop/server/settings'
import { findDesktopAgent } from '@/lib/desktop/server/store'
import { EngineRequestError, getAgent, patchAgent } from '@/lib/engine/client'

type Context = { params: Promise<{ agentId: string }> }

function pausedReason(id: string, config: AgentConfig): string | undefined {
    if (id === 'memoryRecall' && !config.tools.memory) return 'Turn on Use saved memories in chat in Edit coworker.'
    if (id === 'memoryWrite' && (!config.selfImprovement.enabled || !config.selfImprovement.autoMemory)) return 'Memory learning is paused for this coworker.'
}

async function toolsFor(runtime: DesktopRuntime, id: string, patch?: CoworkerToolPatch) {
    const owner = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), id)
    if (!owner) throw new DesktopHttpError(404, 'Coworker not found')
    if (patch) {
        const row = coworkerToolCatalogs[patch.group].find(entry => entry.id === patch.id)
        if (!row?.available) throw new DesktopHttpError(400, 'This tool is unavailable for this coworker.')
    }
    const engine = engineOf(runtime)
    try {
        const current = await getAgent(engine, owner.engineAgentId)
        if (patch?.group === 'rerun' && patch.enabled && pausedReason(patch.id, current.config)) {
            throw new DesktopHttpError(400, 'Turn on this coworker’s memory preference first.')
        }
        const agent = patch ? await patchAgent(engine, owner.engineAgentId, { tools: {
            [patch.group === 'codex' ? 'desktopCodexGrants' : 'desktopToolGrants']: { [patch.id]: patch.enabled },
        } }) : current
        const rerun: Record<string, boolean> = desktopRerunGrantsOf(agent.config.tools)
        const codex: Record<string, boolean> = desktopCodexGrantsOf(agent.config.tools)
        return Response.json({
            rerun: coworkerToolCatalogs.rerun.map(row => {
                const reason = pausedReason(row.id, agent.config)
                return { ...row, ...(reason && { available: false, unavailableReason: reason }), enabled: row.available && rerun[row.id] === true }
            }),
            codex: coworkerToolCatalogs.codex.map(row => ({ ...row, enabled: row.available && codex[row.id] === true })),
        }, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
        if (error instanceof DesktopHttpError) throw error
        if (error instanceof EngineRequestError && error.status === 404) throw new DesktopHttpError(404, 'Coworker not found')
        throw new DesktopHttpError(502, 'Could not reach this coworker’s tools. Try again.')
    }
}

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => toolsFor(runtime, (await params).agentId))
}

export function PATCH(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const patch = coworkerToolPatch.safeParse(await request.json().catch(() => null))
        if (!patch.success) throw new DesktopHttpError(400, 'Choose a valid tool permission.')
        return toolsFor(runtime, (await params).agentId, patch.data)
    })
}
