import { LEGACY_WORKSPACE_ID, appDatabasePath, engineRootFor, workspaceDirectory } from './paths.mjs'

/**
 * Isolation inventory for W1 local. Default is full isolation. Shared provider
 * preferences require an explicit allowlist entry in the contract
 * (`desktopWorkspaceSharedPreferenceKeys`, currently empty).
 *
 * This module never reads Keychain, live secrets, or user databases.
 */
export const ISOLATION_PLAN = Object.freeze({
    engine_root: {
        rule: 'exclusive',
        pathFor: (dataRoot, workspaceId) => engineRootFor(dataRoot, workspaceId),
        note: 'bindWorkspace must use workspaces/{id}/engine; desktop-owner.json seals installId+workspaceId.',
    },
    app_database: {
        rule: 'exclusive',
        pathFor: (dataRoot, workspaceId) => appDatabasePath(dataRoot, workspaceId),
        note: 'Workspace 1 keeps {dataRoot}/app.db. Newer workspaces need root W1-A5 before rows are written.',
    },
    chats_and_sessions: { rule: 'exclusive', note: 'desktop_sessions / tabs scoped to the active workspace database.' },
    grants: { rule: 'exclusive', note: 'Tool grants and approval receipts stay inside the workspace DB.' },
    browser_sessions: { rule: 'exclusive', note: 'Guest browser profiles live under the workspace engine root.' },
    documents: { rule: 'exclusive', note: 'Document attachments and shared files resolve under the workspace engine root.' },
    local_mcp: { rule: 'exclusive', note: 'stdio/SSE MCP installs and shutdown drain with the workspace runtime.' },
    templates: { rule: 'exclusive', note: 'Local template library revisions stay in the workspace DB/files.' },
    brain_memory: { rule: 'exclusive', note: 'Brain pages and memories are workspace-scoped.' },
    provider_credentials: {
        rule: 'exclusive',
        note: 'Provider secrets remain in the existing secure custody path keyed by workspace; this package never migrates them.',
    },
    foreman_state: { rule: 'exclusive', note: 'Foreman chats/revisions/builds carry workspaceId and must not cross switches.' },
    drafts: { rule: 'exclusive', note: 'Composer drafts flush before switch; unsent text stays with the source workspace DB.' },
    board_layout: { rule: 'exclusive', note: 'Board camera/spaces restore per workspace after switch navigation.' },
    schedules: { rule: 'exclusive', note: 'Schedule bindings are runtime-scoped; freeze admissions before drain.' },
    services_accounts: { rule: 'exclusive', note: 'Service installs/accounts stay in the workspace DB.' },
})

export function isolationRoots(dataRoot, workspaceId) {
    return {
        workspaceId: Number(workspaceId) || LEGACY_WORKSPACE_ID,
        directory: workspaceDirectory(dataRoot, workspaceId),
        engineRoot: engineRootFor(dataRoot, workspaceId),
        appDatabase: appDatabasePath(dataRoot, workspaceId),
    }
}
