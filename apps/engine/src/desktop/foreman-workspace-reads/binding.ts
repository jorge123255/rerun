import { createForemanWorkspaceReadTools } from './tools.js'
import type { ForemanWorkspaceReadContext, ForemanWorkspaceReadPorts } from './ports.js'

export type ForemanWorkspaceReadBinding = {
    grant: ForemanWorkspaceReadPorts['grant']
    tools: (ctx: ForemanWorkspaceReadContext) => ReturnType<ReturnType<typeof createForemanWorkspaceReadTools>['tools']>
}

let current: ForemanWorkspaceReadBinding | undefined

/**
 * Root calls this with the runtime grant and the catalog snapshot.
 * The snapshot must call readDesktopBoardState and listDesktopAgents.
 * Until this is called, Foreman does not see these tools.
 * Grant and snapshot are invoked again on every call. A false grant is a refusal.
 */
export function bindForemanWorkspaceReads(ports: ForemanWorkspaceReadPorts): ForemanWorkspaceReadBinding {
    const factory = createForemanWorkspaceReadTools(ports)
    current = { grant: ports.grant, tools: factory.tools }
    return current
}

export function readForemanWorkspaceReads(): ForemanWorkspaceReadBinding | undefined {
    return current
}

export function unbindForemanWorkspaceReads(): void {
    current = undefined
}
