import type { ApiConnectionRoutes } from './client'

export const desktopApiConnectionEngineRoutes: ApiConnectionRoutes = {
    catalog: workspaceId => `/desktop/api-connections/catalog?workspaceId=${workspaceId}`,
    removalPlan: (workspaceId, connectionId) => `/desktop/api-connections/removal?workspaceId=${workspaceId}&connectionId=${encodeURIComponent(connectionId)}`,
    mutation: (_workspaceId, kind) => `/desktop/api-connections/${kind}`,
}

export const desktopApiConnectionUiRoutes: ApiConnectionRoutes = {
    catalog: workspaceId => `/api/desktop/api-connections/${workspaceId}/catalog`,
    removalPlan: (workspaceId, connectionId) => `/api/desktop/api-connections/${workspaceId}/connections/${encodeURIComponent(connectionId)}/removal`,
    mutation: (workspaceId, kind) => `/api/desktop/api-connections/${workspaceId}/${kind}`,
}
