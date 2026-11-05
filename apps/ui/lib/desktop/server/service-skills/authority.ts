import 'server-only'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { bindDesktopSkillOwnerReader } from '../../../../../engine/src/desktop/service-skills/authority'
import { openDesktopDatabase } from '../database'
import { abortable } from '../mcp/remote'
import type { DesktopRuntime } from '../runtime'
import { serviceStore } from '../services/store'
import { serviceSkillJournal } from '../services/skill-journal'
import { connectorSkillAuthority } from '../services/skill-ownership'

async function resolveScope(runtime: DesktopRuntime, engineId: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(engineId)) throw new Error('Invalid coworker identity')
    const db = await abortable(openDesktopDatabase(runtime.dataRoot), signal)
    const resolveOwner = async () => {
        const rows = (await abortable(db.execute({ sql: `SELECT id FROM desktop_agents a WHERE workspace_id=1 AND engine_agent_id=?
            AND NOT EXISTS(SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)`, args: [engineId] }), signal)).rows
        if (rows.length !== 1) throw new Error('Coworker is unavailable')
        return String(rows[0].id)
    }
    const owner = await resolveOwner(), data = await abortable(realpath(/* turbopackIgnore: true */ runtime.dataRoot), signal)
    const agentRoot = join(/* turbopackIgnore: true */ data, 'workspaces', '1', 'engine', 'agents', engineId)
    for (const path of [data, join(/* turbopackIgnore: true */ data, 'workspaces'), join(/* turbopackIgnore: true */ data, 'workspaces', '1'), join(/* turbopackIgnore: true */ data, 'workspaces', '1', 'engine'), dirname(agentRoot), agentRoot]) {
        const info = await abortable(lstat(/* turbopackIgnore: true */ path), signal)
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || await abortable(realpath(/* turbopackIgnore: true */ path), signal) !== path) throw new Error('Coworker storage changed')
    }
    if (await resolveOwner() !== owner) throw new Error('Coworker changed')
    return { owner, engineId, skillsRoot: join(/* turbopackIgnore: true */ agentRoot, 'skills') }
}

/** Canonical read-only authority. It never initializes MCP, reads a credential or calls the engine. */
export async function readDesktopServiceSkillOwners(runtime: DesktopRuntime, engineId: string, signal: AbortSignal): Promise<Map<string, string>> {
    const scope = await resolveScope(runtime, engineId, signal)
    const db = await abortable(openDesktopDatabase(runtime.dataRoot), signal)
    const current = async () => {
        const now = await resolveScope(runtime, engineId, signal)
        if (now.owner !== scope.owner) throw new Error('Coworker changed')
        return now
    }
    const store = serviceStore(db, () => { throw new Error('Credential access is not part of skill ownership') })
    const authority = connectorSkillAuthority(store, serviceSkillJournal(db), current)
    const projected = await abortable(authority.projection(scope.owner, signal), signal)
    signal.throwIfAborted()
    return new Map(projected.map(skill => [skill.slug, skill.serviceName || 'App']))
}

export function bindDesktopServiceSkillOwners(runtime: DesktopRuntime): void {
    bindDesktopSkillOwnerReader(async (workspace, signal) => {
        const engineId = basename(dirname(workspace))
        if (resolve(/* turbopackIgnore: true */ workspace) !== join(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ runtime.dataRoot), 'workspaces', '1', 'engine', 'agents', engineId, 'workspace')) throw new Error('Coworker storage mismatch')
        return readDesktopServiceSkillOwners(runtime, engineId, signal)
    })
}

/** Offline restart scope: no engine call, credential access or provider probe. */
export async function desktopServiceSkillRestartScope(runtime: DesktopRuntime, owner: string, signal: AbortSignal) {
    const db = await abortable(openDesktopDatabase(runtime.dataRoot), signal)
    const rows = (await abortable(db.execute({ sql: 'SELECT engine_agent_id FROM desktop_agents WHERE id=? AND workspace_id=1', args: [owner] }), signal)).rows
    if (rows.length !== 1) throw new Error('Coworker is unavailable')
    const scope = await resolveScope(runtime, String(rows[0].engine_agent_id), signal)
    if (scope.owner !== owner) throw new Error('Coworker changed')
    return scope
}
