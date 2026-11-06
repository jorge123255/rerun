'use client'

import type {
    DesktopWorkspaceCreateInput,
    DesktopWorkspaceCreateResult,
    DesktopWorkspaceListResult,
    DesktopWorkspaceRenameInput,
    DesktopWorkspaceRenameResult,
    DesktopWorkspaceSwitchInput,
    DesktopWorkspaceSwitchResult,
} from '@rerun/contracts'

export type DesktopWorkspaceClient = {
    list: () => Promise<DesktopWorkspaceListResult>
    create: (input: DesktopWorkspaceCreateInput) => Promise<DesktopWorkspaceCreateResult>
    rename: (input: DesktopWorkspaceRenameInput) => Promise<DesktopWorkspaceRenameResult>
    switchTo: (input: DesktopWorkspaceSwitchInput) => Promise<DesktopWorkspaceSwitchResult>
}

async function post<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
    })
    return response.json() as Promise<T>
}

/** Browser client for root-mounted /api/desktop/workspaces/* routes. */
export function createDesktopWorkspaceClient(base = '/api/desktop/workspaces'): DesktopWorkspaceClient {
    return {
        list: async () => {
            const response = await fetch(base, { credentials: 'same-origin' })
            return response.json() as Promise<DesktopWorkspaceListResult>
        },
        create: input => post(`${base}/create`, input),
        rename: input => post(`${base}/rename`, input),
        switchTo: input => post(`${base}/switch`, input),
    }
}
