import { desktopCodexGrantsOf, desktopRerunGrantsOf, type AgentConfig } from '@rerun/contracts'
import { coworkerToolCatalogs, coworkerToolPatch, type CoworkerToolPatch } from '@/lib/desktop/coworker-tools'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { engineOf } from '@/lib/desktop/server/settings'
import { findDesktopAgent } from '@/lib/desktop/server/store'
import { EngineRequestError, getAgent, patchAgent } from '@/lib/engine/client'
import type { EngineAgentConfigPatch } from '@/lib/engine/types'

type Context = { params: Promise<{ agentId: string }> }

// The rerun self-improvement group is nested: the master switch lives on the engine config
// (selfImprovement.enabled), the two permissions on the desktop grant map, and each is
// rechecked against the current config at execution. Enabling a permission behind an off
// master is refused here so the switch never shows a grant that cannot run.
function pausedReason(id: string, config: AgentConfig): string | undefined {
    if (id === 'memoryRecall' && !config.tools.memory) return 'Turn on Use saved memories in chat in Edit coworker.'
    if (id === 'memoryWrite' && (!config.selfImprovement.enabled || !config.selfImprovement.autoMemory)) return 'Memory learning is paused for this coworker.'
    if ((id === 'selfInstruction' || id === 'verbositySet') && !config.selfImprovement.enabled) return 'Turn on Improve itself to change this permission.'
}

function toolPayload(patch: CoworkerToolPatch): EngineAgentConfigPatch {
    if (patch.group === 'rerun' && patch.id === 'self') return { selfImprovement: { enabled: patch.enabled } }
    if (patch.group === 'rerun' && (patch.id === 'selfInstruction' || patch.id === 'verbositySet')) {
        return { tools: { desktopToolGrants: { [patch.id]: patch.enabled } } }
    }
    return { tools: { [patch.group === 'codex' ? 'desktopCodexGrants' : 'desktopToolGrants']: { [patch.id]: patch.enabled } } }
}

async function toolsFor(runtime: DesktopRuntime, id: string, patch?: CoworkerToolPatch) {
    const owner = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), id)
    if (!owner) throw new DesktopHttpError(404, 'Coworker not found')
    const engine = engineOf(runtime)
    try {
        const current = await getAgent(engine, owner.engineAgentId)
        if (patch) {
            const row = coworkerToolCatalogs[patch.group].find(entry => entry.id === patch.id)
            if (!row?.available) throw new DesktopHttpError(400, 'This tool is unavailable for this coworker.')
            if (patch.group === 'rerun' && patch.enabled) {
                if ((patch.id === 'memoryRecall' || patch.id === 'memoryWrite') && pausedReason(patch.id, current.config)) {
                    throw new DesktopHttpError(400, 'Turn on this coworker’s memory preference first.')
                }
                if ((patch.id === 'selfInstruction' || patch.id === 'verbositySet') && !current.config.selfImprovement.enabled) {
                    throw new DesktopHttpError(400, 'Turn on Improve itself to change this permission.')
                }
            }
        }
        const agent = patch ? await patchAgent(engine, owner.engineAgentId, toolPayload(patch)) : current
        const rerun: Record<string, boolean> = desktopRerunGrantsOf(agent.config.tools)
        const master = agent.config.selfImprovement.enabled
        const codex: Record<string, boolean> = desktopCodexGrantsOf(agent.config.tools)
        return Response.json({
            rerun: coworkerToolCatalogs.rerun.map(row => {
                const nested = row.parent === 'self'
                const reason = pausedReason(row.id, agent.config)
                const enabled = row.id === 'self' ? master : nested ? master && rerun[row.id] === true : rerun[row.id] === true
                return { ...row, ...(reason && { available: false, unavailableReason: reason }), enabled: row.available && enabled }
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
