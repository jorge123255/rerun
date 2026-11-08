import { Hono } from 'hono'
import { CUSTOM_DEFAULT_CONTEXT_WINDOW, type CustomProviderSnapshot } from '@rerun/contracts'
import { raw } from '../../db/client.js'
import { readBoxDefault } from '../../connections/default.js'
import { connectionExists } from '../../connections/loader.js'
import { unloadConnection } from '../../connections/registry.js'
import type { LoadedConnection } from '../../connections/types.js'
import { desktopApiConnectionCustodyKey } from '../api-connections/runtime.js'
import { assertDesktopRunAdmission } from '../workspace-admission.js'
import { bindRegisteredCustomConnection } from './connection.js'
import { createCustomProviderRuntime } from './runtime.js'
import { handleCustomProviderRequest } from './router.js'
import { createCustomConnectionStore, isCustomConnectionId, withCustomConnectionWrite } from './store.js'

let installed: ReturnType<typeof createBinding> | undefined

function createBinding(workspaceId: number, launchNonce: string, stopping: () => boolean) {
    let lifetime = new AbortController()
    let closed = false
    const assertActive = () => {
        if (closed || stopping()) throw new Error('Custom providers are unavailable for this launch.')
        assertDesktopRunAdmission()
    }
    const store = createCustomConnectionStore({ db: raw(), workspaceId, key: () => {
        const key = desktopApiConnectionCustodyKey()
        if (!key) throw new Error('Custom credential storage is unavailable.')
        return key
    }, assertActive, readDefault: readBoxDefault, idExists: connectionExists, changed: unloadConnection })
    const runtime = createCustomProviderRuntime(bindRegisteredCustomConnection(store.authority))
    const routes = new Hono()
    routes.post('/', c => {
        if (c.req.header('x-rerun-launch-nonce') !== launchNonce) return c.json({ error: 'The app launch changed.' }, 409)
        const signal = AbortSignal.any([c.req.raw.signal, lifetime.signal])
        return handleCustomProviderRequest(store.authority, runtime, workspaceId, async current => {
            current.throwIfAborted()
            assertActive()
        }, c.req.raw, signal)
    })
    return {
        workspaceId, routes,
        async get(id: string): Promise<LoadedConnection | null> {
            const saved = await store.row(id)
            if (!saved) return null
            const { snapshot } = saved
            return { id, config: { name: snapshot.config.name, provider: 'custom', baseUrl: snapshot.config.baseUrl,
                models: snapshot.config.models.map(model => model.id), extraModels: [], createdAt: saved.createdAt }, env: {}, custom: snapshot }
        },
        ids: store.ids,
        model(snapshot: CustomProviderSnapshot, modelId: string, signal: AbortSignal) {
            assertActive()
            const { workspaceId, connectionId, revision } = snapshot
            return runtime.model({ workspaceId, connectionId, revision }, modelId, AbortSignal.any([signal, lifetime.signal]))
        },
        abort() { lifetime.abort(); lifetime = new AbortController() },
        close() { closed = true; lifetime.abort(); runtime.close() },
    }
}

export function bindDesktopCustomProviders(workspaceId: number, launchNonce: string, stopping: () => boolean) {
    if (installed) throw new Error('Custom providers are already bound.')
    const binding = createBinding(workspaceId, launchNonce, stopping)
    installed = binding
    return { routes: binding.routes, abort: binding.abort, close() { binding.close(); if (installed === binding) installed = undefined } }
}

export const desktopCustomProviderBinding = () => installed
export function readRegisteredCustomConnection(id: string) {
    return installed && isCustomConnectionId(id) ? installed.get(id) : null
}
export function selectRegisteredCustomDefault<T>(id: string, select: () => Promise<T>): Promise<T> {
    if (!installed || !isCustomConnectionId(id)) return select()
    return withCustomConnectionWrite(installed.workspaceId, async () => {
        assertDesktopRunAdmission()
        return select()
    })
}
export function customConnectionContextWindow(connection: LoadedConnection | null, modelId: string) {
    const snapshot = connection?.custom
    if (!snapshot) return null
    return snapshot.catalog.models.find(model => model.id === modelId)?.contextWindow
        ?? snapshot.config.models.find(model => model.id === modelId)?.contextWindow
        ?? snapshot.config.contextWindow ?? CUSTOM_DEFAULT_CONTEXT_WINDOW
}
