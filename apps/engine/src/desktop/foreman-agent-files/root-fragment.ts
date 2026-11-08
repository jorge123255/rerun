export { foremanAgentFileCatalogEntries, foremanAgentFileGrantIds, FOREMAN_AGENT_FILE_READ_TOOLS, FOREMAN_AGENT_FILE_WRITE_TOOLS } from './contract.js'

/** Exact ids root appends to `desktopRerunGrantIds` in packages/contracts/src/desktop-tool-grants.ts. */
export const foremanAgentFileGrantEnumLines = [
    'foremanAgentFilesRead',
    'foremanAgentFilesWrite',
] as const

/**
 * Root also spreads `foremanAgentFileCatalogEntries` into `desktopRerunToolCatalog`.
 * Until those ids are in the enum, agent config parsing drops them and both gates stay off.
 * Do not mount hosted `agentFilesTools`. Brain write, delete, proposals, and decide stay on their review path.
 */
export const foremanAgentFileRootBinding = {
    grantFile: 'packages/contracts/src/desktop-tool-grants.ts',
    enumConst: 'desktopRerunGrantIds',
    catalogConst: 'desktopRerunToolCatalog',
    barrelFile: 'packages/contracts/src/index.ts',
    barrelLine: "export * from './desktop-foreman-agent-files.js'",
    registry: 'apps/engine/src/tools/registry.ts',
    registryNote: 'No registry edit. desktopForemanTools already returns before hosted agentFilesTools, and binding.ts adds these tools only for Foreman.',
} as const
