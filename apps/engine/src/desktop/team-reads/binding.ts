import { createDesktopTeamReadTools, type DesktopTeamReadBindingInput } from './tools.js'

export type DesktopTeamReadBinding = {
    grant: DesktopTeamReadBindingInput['grant']
    admit: DesktopTeamReadBindingInput['admit']
    directory: DesktopTeamReadBindingInput['directory']
    reads: DesktopTeamReadBindingInput['reads']
    tools: ReturnType<typeof createDesktopTeamReadTools>['tools']
}

let current: DesktopTeamReadBinding | undefined

/**
 * Root calls this with the workspace directory and the saved-run reader.
 * This does not open a second database, mint a token, start a listener, or run a coworker.
 * An uncertain read is returned as unavailable and is not retried.
 * Until this is called, `readDesktopTeamReads()` is undefined and no team tool is mounted.
 */
export function bindDesktopTeamReads(input: DesktopTeamReadBindingInput): DesktopTeamReadBinding {
    const factory = createDesktopTeamReadTools(input)
    current = { grant: input.grant, admit: input.admit, directory: input.directory, reads: input.reads, tools: factory.tools }
    return current
}

export function readDesktopTeamReads(): DesktopTeamReadBinding | undefined {
    return current
}

/** Drops the in-process binding only. Does not delete coworker files or runs. */
export function unbindDesktopTeamReads(): void {
    current = undefined
}
