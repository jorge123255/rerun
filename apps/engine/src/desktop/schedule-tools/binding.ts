import type { Client } from '@libsql/client'
import { createDesktopScheduleLifecycle, type DesktopScheduleLifecycle } from './lifecycle.js'
import { createDesktopScheduleIntentStore } from './intents.js'
import { desktopScheduleFiles } from './files.js'
import { DESKTOP_SCHEDULE_TOOL_SCHEMA_SQL } from './schema.js'
import { createDesktopScheduleToolFactory } from './tools.js'
import type { DesktopScheduleFilePort, DesktopScheduleIntentStore, DesktopScheduleToolAuthority } from './types.js'

export { DESKTOP_SCHEDULE_TOOL_SCHEMA_SQL }

export type DesktopScheduleToolBinding = {
    store: DesktopScheduleIntentStore
    files: DesktopScheduleFilePort
    lifecycle: DesktopScheduleLifecycle
    authority: DesktopScheduleToolAuthority
    tools: ReturnType<typeof createDesktopScheduleToolFactory>['tools']
    projection: ReturnType<typeof createDesktopScheduleToolFactory>['projection']
    /** Seal landed or divergent receipts. Does not start a run or apply an unlanded write. */
    recover: DesktopScheduleLifecycle['recover']
}

let current: DesktopScheduleToolBinding | undefined

/**
 * Root calls this after the schedule file store is available and before a coworker tool call.
 * getSystemClient opens the coworker's existing system database. This only adds the intent table.
 */
export function bindDesktopScheduleTools(input: {
    authority: DesktopScheduleToolAuthority
    getSystemClient?: (engineAgentId: string) => Promise<Client>
    files?: DesktopScheduleFilePort
    store?: DesktopScheduleIntentStore
    now?: () => Date
}): DesktopScheduleToolBinding {
    if (!input.authority) throw new Error('Desktop schedule tool authority is required')
    const files = input.files ?? desktopScheduleFiles()
    const store = input.store ?? (input.getSystemClient ? createDesktopScheduleIntentStore(input.getSystemClient) : undefined)
    if (!store) throw new Error('Desktop schedule tool receipts require the system database')
    const lifecycle = createDesktopScheduleLifecycle({ authority: input.authority, files, store, now: input.now })
    const factory = createDesktopScheduleToolFactory({ authority: input.authority, lifecycle, store })
    current = { store, files, lifecycle, authority: input.authority, tools: factory.tools, projection: factory.projection, recover: lifecycle.recover }
    return current
}

export function readDesktopScheduleTools(): DesktopScheduleToolBinding | undefined {
    return current
}
