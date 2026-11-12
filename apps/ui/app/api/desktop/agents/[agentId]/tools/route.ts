import { desktopCodexGrantsOf, desktopRerunGrantsOf, type AgentConfig } from '@rerun/contracts'
import { coworkerToolCatalogs, coworkerToolPatch, type CoworkerToolPatch } from '@/lib/desktop/coworker-tools'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopAppStoreBuild, type DesktopRuntime } from '@/lib/desktop/server/runtime'
import { engineOf } from '@/lib/desktop/server/settings'
import { findDesktopAgent } from '@/lib/desktop/server/store'
import { EngineRequestError, getAgent, patchAgent } from '@/lib/engine/client'
import type { EngineAgentConfigPatch } from '@/lib/engine/types'
import { withDesktopMcpOwnerTransition } from '@/lib/desktop/server/mcp-binding'
import { withDesktopSecretOwnerTransition } from '@/lib/desktop/server/secret-requests/lifecycle'

type Context = { params: Promise<{ agentId: string }> }

// The rerun self-improvement group is nested: the master switch lives on the engine config
// (selfImprovement.enabled), the two permissions on the desktop grant map, and each is
// rechecked against the current config at execution. Enabling a permission behind an off
// master is refused here so the switch never shows a grant that cannot run.
function pausedReason(id: string, config: AgentConfig): string | undefined {
    if (id === 'privateFileWrite' && !config.tools.filesystem) return 'File editing is paused for this coworker.'
    if (id === 'sharedFilesRead' && config.tools.shared === false) return 'Shared files access is paused for this coworker.'
    if (id === 'memoryRecall' && !config.tools.memory) return 'Turn on Use saved memories in chat in Edit coworker.'
    if (id === 'memoryWrite' && (!config.selfImprovement.enabled || !config.selfImprovement.autoMemory)) return 'Memory learning is paused for this coworker.'
    if ((id === 'selfInstruction' || id === 'verbositySet' || id === 'selfMcpRegister' || id === 'toolInstall') && !config.selfImprovement.enabled) return 'Turn on Improve itself to change this permission.'
}

function toolPayload(patch: CoworkerToolPatch): EngineAgentConfigPatch {
    if (patch.group === 'rerun' && patch.id === 'toolInstall') return { tools: { desktopToolGrants: { toolInstall: patch.enabled } }, selfImprovement: { allowToolInstall: patch.enabled } }
    if (patch.group === 'rerun' && patch.id === 'self') return { selfImprovement: { enabled: patch.enabled } }
    if (patch.group === 'rerun' && (patch.id === 'selfInstruction' || patch.id === 'verbositySet' || patch.id === 'selfMcpRegister' || patch.id === 'toolInstall')) {
        return { tools: { desktopToolGrants: { [patch.id]: patch.enabled } } }
    }
    return { tools: { [patch.group === 'codex' ? 'desktopCodexGrants' : 'desktopToolGrants']: { [patch.id]: patch.enabled } } }
}

const directBuildRequired = 'This tool requires the direct Mac build.'
const requiresDirectBuild = (group: 'codex' | 'rerun', id: string) => group === 'codex' || id === 'nativeWriteback'

async function toolsFor(runtime: DesktopRuntime, id: string, patch?: CoworkerToolPatch) {
    const owner = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), id)
    if (!owner) throw new DesktopHttpError(404, 'Coworker not found')
    const engine = engineOf(runtime)
    try {
        const current = await getAgent(engine, owner.engineAgentId)
        const appStore = desktopAppStoreBuild()
        if (patch) {
            if (appStore && patch.enabled && requiresDirectBuild(patch.group, patch.id)) throw new DesktopHttpError(400, directBuildRequired)
            const row = coworkerToolCatalogs[patch.group].find(entry => entry.id === patch.id)
            if (!row?.available) throw new DesktopHttpError(400, 'This tool is unavailable for this coworker.')
            if (patch.group === 'rerun' && patch.enabled) {
                if (patch.id === 'privateFileWrite' && !current.config.tools.filesystem) throw new DesktopHttpError(400, 'File editing is paused for this coworker.')
                if (patch.id === 'sharedFilesRead' && pausedReason(patch.id, current.config)) throw new DesktopHttpError(400, 'Shared files access is paused for this coworker.')
                if ((patch.id === 'memoryRecall' || patch.id === 'memoryWrite') && pausedReason(patch.id, current.config)) {
                    throw new DesktopHttpError(400, 'Turn on this coworker’s memory preference first.')
                }
                if ((patch.id === 'selfInstruction' || patch.id === 'verbositySet' || patch.id === 'selfMcpRegister' || patch.id === 'toolInstall') && !current.config.selfImprovement.enabled) {
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
                const enabled = !reason && (row.id === 'toolInstall' && !agent.config.selfImprovement.allowToolInstall ? false : row.id === 'self' ? master : nested ? master && rerun[row.id] === true : rerun[row.id] === true)
                if (appStore && requiresDirectBuild('rerun', row.id)) return { ...row, available: false, unavailableReason: directBuildRequired, enabled }
                return { ...row, ...(reason && { available: false, unavailableReason: reason }), enabled: row.available && enabled }
            }),
            codex: coworkerToolCatalogs.codex.map(row => ({
                ...row, ...(appStore && { available: false, unavailableReason: directBuildRequired }),
                enabled: row.available && codex[row.id] === true,
            })),
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
        const agentId = (await params).agentId
        const write = () => toolsFor(runtime, agentId, patch.data)
        const transitionsLocalAuthority = patch.data.group === 'rerun'
            ? ['self', 'selfMcpRegister', 'mcp', 'privateFileWrite', 'localMcpStdio', 'nativeWriteback', 'services'].includes(patch.data.id)
            : ['workspaceRead', 'workspaceWrite'].includes(patch.data.id)
        if (patch.data.group === 'rerun' && patch.data.id === 'requestSecret') return withDesktopSecretOwnerTransition(runtime, agentId, write)
        return transitionsLocalAuthority ? withDesktopMcpOwnerTransition(runtime, agentId, write) : write()
    })
}
