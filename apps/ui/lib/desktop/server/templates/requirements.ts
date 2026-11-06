import 'server-only'
import type { Client } from '@libsql/client'
import { desktopTemplateGuidedSetup, type DesktopTemplateRequirement } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'

// Root provides current engine -> local coworker ownership; names never come from services.json.
export function createTemplateAppRequirementProjection(db: Pick<Client, 'execute'>, localOwner: (engineAgentId: string) => Promise<string>) {
    return async (engineAgentId: string): Promise<DesktopTemplateRequirement[]> => {
        const owner = await localOwner(engineAgentId)
        const rows = await db.execute({ sql:'SELECT slug FROM desktop_service_installs WHERE owner=? AND engine_id=? AND state != ? ORDER BY slug', args:[owner, engineAgentId, 'removed'] })
        const names = [...new Set(rows.rows.map(r => String(r.slug)))]
        if (names.length > 100 || names.some(n => !/^[a-z0-9][a-z0-9-]{0,127}$/.test(n))) throw new DesktopHttpError(409, 'App requirement names are not supported')
        return names.map(name => ({ kind:'service-reconnect', name, detail:'Connect this app locally after installation.' }))
    }
}
export function importedTemplateSetup(setup: { required: boolean | null; prompt: string }, rawRequirements: unknown) {
    try { return desktopTemplateGuidedSetup(setup, rawRequirements) }
    catch { throw new DesktopHttpError(409, 'Template setup requirements are not supported') }
}
