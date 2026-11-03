import 'server-only'
import { CONNECTION_TOKEN_KEY, DEFAULT_CONNECTION_MODELS, PROVIDER_LABELS } from '@rerun/contracts'
import { createConnection, listConnections, patchConnection, setBoxDefault, updateConnectionKeys } from '@/lib/engine/client'
import { desktopProvider, type SettingsChange } from '../settings'
import { DesktopHttpError } from './auth'
import { reconcileDesktopRenames } from './coworker-rename'
import { openDesktopDatabase } from './database'
import { readDesktopBootstrap } from './store'
import { desktopAgentView } from './views'
import type { DesktopRuntime } from './runtime'

export function engineOf(runtime: DesktopRuntime) {
    return { baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }
}

export async function readDesktopProviders(runtime: DesktopRuntime) {
    const list = await listConnections(engineOf(runtime), { cache: 'no-store' })
    const connections = list.connections.filter(c => desktopProvider.safeParse(c.provider).success)
    return { connections, default: list.default }
}

export async function readDesktopWorkspace(runtime: DesktopRuntime) {
    const [bootstrap, providers] = await Promise.all([
        openDesktopDatabase(runtime.dataRoot).then(async db => {
            await reconcileDesktopRenames(db, engineOf(runtime), runtime.launchNonce)
            return readDesktopBootstrap(db)
        }),
        readDesktopProviders(runtime),
    ])
    return { ...bootstrap, ...providers, agents: bootstrap.agents.map(desktopAgentView) }
}

export async function desktopModel(runtime: DesktopRuntime) {
    const list = await readDesktopProviders(runtime)
    const pick = list.default
    const connection = list.connections.find(c => c.id === pick?.connectionId)
    if (!pick || !connection?.connected || ![...connection.models, ...connection.extraModels].includes(pick.model)) {
        throw new DesktopHttpError(400, 'Connect a provider and choose a default model in Settings.')
    }
    return { connection, model: pick.model, connections: list.connections }
}

// Serialize settings writes inside the desktop UI server. Two rapid submissions should update
// the same provider, and a default cannot change midway through an edit to its offered models.
let pending = Promise.resolve()
export function changeDesktopSettings(runtime: DesktopRuntime, change: SettingsChange) {
    const result = pending.then(() => applyChange(runtime, change))
    pending = result.then(() => {}, () => {})
    return result
}

async function applyChange(runtime: DesktopRuntime, change: SettingsChange) {
    if (change.action === 'appearance') {
        const db = await openDesktopDatabase(runtime.dataRoot)
        await db.execute({
            sql: 'INSERT INTO desktop_appearance (workspace_id, theme) VALUES (1, ?) ON CONFLICT(workspace_id) DO UPDATE SET theme = excluded.theme',
            args: [change.theme],
        })
        return
    }
    if (change.action === 'workspace') {
        const db = await openDesktopDatabase(runtime.dataRoot)
        await db.execute({ sql: 'UPDATE desktop_workspace SET name = ?, updated_at = ? WHERE id = 1', args: [change.name, new Date().toISOString()] })
        return
    }
    const engine = engineOf(runtime)
    const list = await readDesktopProviders(runtime)
    if (change.action === 'key') {
        const existing = change.connectionId ? list.connections.find(c => c.id === change.connectionId) : list.connections.find(c => c.provider === change.provider)
        if (change.connectionId && existing?.provider !== change.provider) throw new DesktopHttpError(400, 'This connection is unavailable.')
        const keys = { [CONNECTION_TOKEN_KEY[change.provider]]: change.apiKey }
        if (existing) await updateConnectionKeys(engine, existing.id, { set: keys })
        else await createConnection(engine, { name: PROVIDER_LABELS[change.provider], provider: change.provider, models: DEFAULT_CONNECTION_MODELS[change.provider], extraModels: [], keys })
        return
    }
    const connection = list.connections.find(c => c.id === change.connectionId)
    if (!connection) throw new DesktopHttpError(404, 'Connection not found.')
    if (change.action === 'default') {
        if (!connection.connected || ![...connection.models, ...connection.extraModels].includes(change.model))
            throw new DesktopHttpError(400, 'Choose a model offered by a connected provider.')
        if (change.reasoningEffort !== undefined) {
            if (connection.provider !== 'codex' || list.default?.connectionId !== connection.id || list.default.model !== change.model)
                throw new DesktopHttpError(400, 'Choose the current Codex model before changing reasoning effort.')
            if (change.reasoningEffort !== null && !connection.codexReasoning?.[change.model]?.supported.includes(change.reasoningEffort))
                throw new DesktopHttpError(400, 'Choose a reasoning effort offered by this Codex model.')
        }
        await setBoxDefault(engine, { connectionId: connection.id, model: change.model, reasoningEffort: change.reasoningEffort })
        return
    }
    if (change.action === 'endpoint') {
        if (connection.provider !== 'openrouter') throw new DesktopHttpError(400, 'Only OpenRouter supports a custom endpoint.')
        await patchConnection(engine, connection.id, { baseUrl: change.baseUrl })
        return
    }
    const curated = DEFAULT_CONNECTION_MODELS[connection.provider]
    const models = [...new Set(change.models)]
    const extras = [...new Set(change.extraModels)]
    const offered = [...models, ...extras]
    if (!offered.length || models.some(m => !curated.includes(m) && !connection.models.includes(m)) ||
        extras.some(m => connection.provider !== 'openrouter' || curated.includes(m) || models.includes(m)))
        throw new DesktopHttpError(400, 'Keep at least one supported model available.')
    if (list.default?.connectionId === connection.id && !offered.includes(list.default.model))
        throw new DesktopHttpError(400, 'Choose another default before removing this model.')
    await patchConnection(engine, connection.id, { models, extraModels: extras })
}
