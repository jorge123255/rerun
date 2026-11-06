// Read/search and write are separate. A read grant never enables create or edit.
// The write grant id is not in the central catalog until root adds it.

export type SharedGrantConfig = {
    enabled?: boolean
    tools?: { shared?: boolean; filesystem?: boolean; desktopToolGrants?: object }
}

function grantsOf(config: SharedGrantConfig): Record<string, boolean> | undefined {
    return config.tools?.desktopToolGrants as Record<string, boolean> | undefined
}

export function sharedReadGranted(config: SharedGrantConfig | null | undefined): boolean {
    if (!config?.enabled) return false
    if (config.tools?.shared === false) return false
    return grantsOf(config)?.sharedFilesRead === true
}

export function sharedWriteGranted(config: SharedGrantConfig | null | undefined): boolean {
    if (!config?.enabled) return false
    if (config.tools?.shared === false) return false
    return grantsOf(config)?.sharedFilesWrite === true
}
