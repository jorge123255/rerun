import type { Client } from '@libsql/client'
import { createDesktopTriggerLifecycle, type DesktopTriggerLifecycle } from './lifecycle.js'
import { createDisabledDesktopTriggerNetworking, type DesktopTriggerNetworking } from './networking.js'
import { createDesktopTriggerIngressHandler } from './ingress.js'
import { recoverDesktopTriggerOwner } from './recovery.js'
import { createDesktopTriggerStore, desktopTriggerStateSchema } from './state.js'
import { createDesktopTriggerToolFactory } from './tools.js'
import { stopDesktopTriggerRun } from './stop.js'
import type { DesktopTriggerAuthority, DesktopTriggerStore } from './types.js'
import { randomUUID } from 'node:crypto'
import { desktopTriggerDefinitionRevision } from './lifecycle.js'

export { desktopTriggerStateSchema }

export type DesktopTriggerEngineBinding = {
    store: DesktopTriggerStore
    lifecycle: DesktopTriggerLifecycle
    networking: DesktopTriggerNetworking
    authority: DesktopTriggerAuthority
    createIngressHandler: (extra?: { resolveEngineAgentId?: (agentIdParam: string) => Promise<string | null> }) => ReturnType<typeof createDesktopTriggerIngressHandler>
    recoverOwner: (engineAgentId: string) => Promise<Awaited<ReturnType<typeof recoverDesktopTriggerOwner>>>
    stopRun: (localAgentId: string, engineAgentId: string, body: unknown) => ReturnType<typeof stopDesktopTriggerRun>
    toolFactory: ReturnType<typeof createDesktopTriggerToolFactory>
    close: () => Promise<void>
}

/**
 * Root constructs this AFTER interrupted-run reconciliation and BEFORE admitting trigger work.
 * Pass a real DesktopTriggerAuthority — never a silent allow-all.
 */
export function bindDesktopTriggers(input: {
    getSystemClient: (engineAgentId: string) => Promise<Client>
    authority: DesktopTriggerAuthority
    networking?: DesktopTriggerNetworking
}): DesktopTriggerEngineBinding {
    if (!input.authority) throw new Error('Desktop trigger authority is required')
    const store = createDesktopTriggerStore(input.getSystemClient)
    const networking = input.networking ?? createDisabledDesktopTriggerNetworking()
    // Ensure authority.origin reflects networking — root may wrap authority to call networking.origin().
    const lifecycle = createDesktopTriggerLifecycle(input.authority, store)
    let closed = false
    const assertOpen = () => {
        if (closed) throw new Error('Desktop triggers are stopping')
        input.authority.assertActive()
    }

    const toolFactory = createDesktopTriggerToolFactory({
        authority: input.authority,
        lifecycle,
        assertModelToolAllowed: async engineAgentId => {
            assertOpen()
            const owner = await input.authority.resolveOwnerByEngineId(engineAgentId)
            if (owner.deleting || !owner.enabled) throw new Error('Triggers unavailable for this coworker')
            await input.authority.assertTriggerGrant(engineAgentId)
            await input.authority.assertSetupClear(engineAgentId)
        },
        newRequestId: () => randomUUID(),
        priorRevision: async (id, requestId) => { const intent = await store.findIntent(id, requestId); return intent?.before ? desktopTriggerDefinitionRevision(intent.before) : null },
    })

    return {
        store,
        lifecycle,
        networking,
        authority: input.authority,
        createIngressHandler: (extra = {}) => {
            assertOpen()
            return createDesktopTriggerIngressHandler({ authority: input.authority, store, ...extra })
        },
        recoverOwner: async engineAgentId => {
            assertOpen()
            return recoverDesktopTriggerOwner({ authority: input.authority, store, engineAgentId })
        },
        stopRun: (localAgentId, engineAgentId, body) =>
            stopDesktopTriggerRun({ authority: input.authority, store, engineAgentId, localAgentId, body }),
        toolFactory,
        close: async () => {
            closed = true
            await networking.stop()
        },
    }
}
