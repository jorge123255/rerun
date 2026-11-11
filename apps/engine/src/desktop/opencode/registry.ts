import { DESKTOP_OPENCODE_CONNECTION_ID } from '@rerun/contracts'
import type { LoadedConnection } from '../../connections/types.js'
import { desktopOpencodeDispatchModel, desktopOpencodeListedModels } from './catalog.js'
import type { createDesktopOpencodeConnectionStore } from './connection-store.js'

type Store = ReturnType<typeof createDesktopOpencodeConnectionStore>
let installed: Store | undefined

export function registerDesktopOpencodeConnection(store: Store | undefined) {
    installed = store
}

export async function readDesktopOpencodeConnection(): Promise<LoadedConnection | null> {
    const view = await installed?.projection().catch(() => null)
    if (!view) return null
    const catalog = new Map(desktopOpencodeListedModels(view.workspaceId).map(model => [model.id, model]))
    const models = view.enabledModelIds.flatMap(id => {
        const model = catalog.get(id)
        return model && (model.plan !== 'console' || view.consoleEnabled) ? [model] : []
    })
    return {
        id: DESKTOP_OPENCODE_CONNECTION_ID,
        config: { provider: 'opencode', name: view.name, models: models.map(model => model.id), extraModels: [],
            createdAt: '', opencodeModels: models },
        env: {},
        opencode: view,
    }
}

export function desktopOpencodeCredential(connection: LoadedConnection, signal: AbortSignal) {
    if (!installed || !connection.opencode) throw new Error('Connect OpenCode in Settings.')
    return installed.credential(connection.opencode.revision, signal)
}

export function desktopOpencodeModelContext(connection: LoadedConnection | null, model: string) {
    if (!connection?.opencode) return null
    const current = desktopOpencodeDispatchModel(connection.opencode.workspaceId, model)
    return current.kind === 'model' ? current.model.contextWindow : null
}

export function withDesktopOpencodeSelection<T>(work: () => Promise<T>) {
    if (!installed) throw new Error('OpenCode is unavailable.')
    return installed.withSelection(work)
}
