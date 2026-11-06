export { DESKTOP_LOCAL_WORKSPACES_SCHEMA_SQL, DESKTOP_LOCAL_WORKSPACES_MIGRATION } from './schema'
export { desktopWorkspaceHandlers } from './api'
export { createDesktopWorkspaceAdapters, createInProcessWorkspaceBridge } from './adapters'
export { MissingDesktopWorkspaceAuthority, type DesktopWorkspaceServerPorts, type DesktopWorkspaceMainBridge } from './ports'
