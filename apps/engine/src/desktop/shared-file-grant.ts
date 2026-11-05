// Shared files are explicitly granted per coworker. Importing a document in the
// shared folder never enables this boolean or changes the hosted tools.shared switch.
// `shared` is not in desktopRerunGrantIds until root adds it, so this reads the
// stored object directly. A missing or parsed-away key leaves the tools off.

export type SharedGrantConfig = {
    enabled?: boolean
    tools?: { shared?: boolean; desktopToolGrants?: object }
}

function sharedGrant(config: SharedGrantConfig): boolean {
    const grants = config.tools?.desktopToolGrants as Record<string, boolean> | undefined
    return grants?.shared === true
}

export function desktopSharedFilesAllowed(config: SharedGrantConfig | null | undefined): boolean {
    if (!config?.enabled) return false
    if (config.tools?.shared === false) return false
    return sharedGrant(config)
}
