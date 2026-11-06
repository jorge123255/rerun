import type { DesktopTriggerLifecycle } from '../triggers/lifecycle.js'
import type { DesktopTriggerStore } from '../triggers/types.js'
import { createDesktopTriggerToolFactory } from './tools.js'
import type { DesktopTriggerToolAuthority } from './types.js'

export type DesktopTriggerToolBinding = {
    lifecycle: DesktopTriggerLifecycle
    store: DesktopTriggerStore
    authority: DesktopTriggerToolAuthority
    tools: ReturnType<typeof createDesktopTriggerToolFactory>['tools']
    projection: ReturnType<typeof createDesktopTriggerToolFactory>['projection']
}

let current: DesktopTriggerToolBinding | undefined

/**
 * Root calls this with the lifecycle and store from `readDesktopTriggerRuntime()`.
 * This does not open a second database, mint tokens, or start a listener.
 * Lost tool acknowledgements reconcile by retrying the same lifecycle call.
 * Delivery recovery stays `recoverDesktopTriggerOwner`; it does not replay a mutation.
 */
export function bindDesktopTriggerTools(input: {
    lifecycle: DesktopTriggerLifecycle
    store: DesktopTriggerStore
    authority: DesktopTriggerToolAuthority
}): DesktopTriggerToolBinding {
    if (!input?.lifecycle || !input.store || !input.authority) throw new Error('Desktop trigger tool authority is required')
    const factory = createDesktopTriggerToolFactory({ authority: input.authority, lifecycle: input.lifecycle, store: input.store })
    current = { lifecycle: input.lifecycle, store: input.store, authority: input.authority, tools: factory.tools, projection: factory.projection }
    return current
}

export function readDesktopTriggerTools(): DesktopTriggerToolBinding | undefined {
    return current
}
