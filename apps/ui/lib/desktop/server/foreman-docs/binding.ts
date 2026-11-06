import 'server-only'
import type { DesktopRuntime } from '../runtime'
import { desktopForeman } from '../foreman/binding'
import { readDesktopForemanDocsCorpus } from './fetch'
import { createDesktopForemanDocsService, DesktopForemanDocsLiveError, type DesktopForemanDocsService } from './service'
import { desktopForemanDocsStore } from './store'

const KEY = Symbol.for('rerun.desktop.foreman.docs.v1')
const bindings = () => ((globalThis as unknown as Record<symbol, Map<string, Promise<DesktopForemanDocsService>>>)[KEY] ??= new Map())

export function desktopForemanDocs(runtime: DesktopRuntime): Promise<DesktopForemanDocsService> {
    const key = JSON.stringify([runtime.dataRoot, runtime.launchNonce, runtime.engine.origin])
    let value = bindings().get(key)
    if (!value) {
        value = createBinding(runtime)
        bindings().set(key, value)
        void value.catch(() => { if (bindings().get(key) === value) bindings().delete(key) })
    }
    return value
}

async function createBinding(runtime: DesktopRuntime): Promise<DesktopForemanDocsService> {
    const foreman = await desktopForeman(runtime)
    return createDesktopForemanDocsService({
        store: desktopForemanDocsStore(foreman.db),
        fetchCorpus: (corpus, signal, assertLive) => readDesktopForemanDocsCorpus(corpus, signal, assertLive),
        assertLive: async (binding, signal) => {
            signal.throwIfAborted()
            if (!await foreman.isLive(binding)) throw new DesktopForemanDocsLiveError()
            signal.throwIfAborted()
        },
    })
}
