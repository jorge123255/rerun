import 'server-only'
import type { Client } from '@libsql/client'
import { desktopTemplateRequirementsSchema, type DesktopTemplateRequirement } from '@rerun/contracts'
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
    const requirements = desktopTemplateRequirementsSchema.parse(rawRequirements ?? [])
    if (requirements.some(r => !(r.kind === 'environment-key' || r.kind === 'credential-name' ? /^[A-Z_][A-Z0-9_]{0,127}$/ : /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).test(r.name))) throw new DesktopHttpError(409, 'Template requirement names are not supported')
    if (!requirements.length) return { prompt:setup.prompt, required:setup.required === true }
    const prompt = [setup.prompt, 'To provide again on a copy:', ...requirements.map(r => `- ${r.kind}: ${r.name}`), 'These are setup requirements only. Nothing is connected and no permission was enabled. Ask the owner to complete or explicitly skip missing setup.'].filter(Boolean).join('\n')
    if (Buffer.byteLength(prompt) > 1048576) throw new DesktopHttpError(413, 'Template setup requirements exceed the prompt bound')
    return { prompt, required:true }
}
