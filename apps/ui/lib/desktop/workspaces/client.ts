'use client'

import { desktopWorkspaceCreateInputSchema, desktopWorkspaceCreateResultSchema, desktopWorkspaceListResultSchema, desktopWorkspaceRenameInputSchema, desktopWorkspaceRenameResultSchema, desktopWorkspaceSwitchInputSchema, desktopWorkspaceSwitchResultSchema,
    type DesktopWorkspaceCreateInput, type DesktopWorkspaceCreateResult, type DesktopWorkspaceListResult, type DesktopWorkspaceRenameInput, type DesktopWorkspaceRenameResult, type DesktopWorkspaceSwitchInput, type DesktopWorkspaceSwitchResult } from '@rerun/contracts'

export type DesktopWorkspaceClient = {
    list: () => Promise<DesktopWorkspaceListResult>
    create: (input: DesktopWorkspaceCreateInput) => Promise<DesktopWorkspaceCreateResult>
    rename: (input: DesktopWorkspaceRenameInput) => Promise<DesktopWorkspaceRenameResult>
    switchTo: (input: DesktopWorkspaceSwitchInput) => Promise<DesktopWorkspaceSwitchResult>
    recoverSwitch?: (input: DesktopWorkspaceSwitchInput) => Promise<DesktopWorkspaceSwitchResult>
    native?: boolean
}
type Bridge = { list: () => Promise<unknown>; create: (input: DesktopWorkspaceCreateInput) => Promise<unknown>; rename: (input: DesktopWorkspaceRenameInput) => Promise<unknown>; switchTo: (input: DesktopWorkspaceSwitchInput) => Promise<unknown>; recoverSwitch?: (input: DesktopWorkspaceSwitchInput) => Promise<unknown> }
export function desktopWorkspaceBridge(): Bridge | undefined {
    return typeof window === 'undefined' ? undefined : (window as Window & { desktopApp?: { workspaces?: Bridge } }).desktopApp?.workspaces
}
async function http(base: string, operation: string, input?: unknown) {
    const response = await fetch(operation === 'list' ? base : `${base}/${operation}`, input === undefined ? { credentials: 'same-origin', cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), credentials: 'same-origin' })
    if (!response.ok) throw new Error('The workspace change could not be confirmed.')
    return response.json()
}
/** Production uses the trusted preload bridge. HTTP is available only to explicit fixture clients. */
export function createDesktopWorkspaceClient(base?: string): DesktopWorkspaceClient {
    const bridge = desktopWorkspaceBridge()
    async function call(operation: keyof Bridge, input?: unknown) {
        if (bridge) {
            const method = bridge[operation]
            if (typeof method !== 'function') throw new Error('Workspace recovery is not available in this build.')
            return input === undefined ? (method as () => Promise<unknown>)() : (method as (input: unknown) => Promise<unknown>)(input)
        }
        if (base) return http(base, operation, input)
        throw new Error('Workspaces are available in the Mac app.')
    }
    return {
        native: Boolean(bridge),
        list: async () => desktopWorkspaceListResultSchema.parse(await call('list')),
        create: async input => desktopWorkspaceCreateResultSchema.parse(await call('create', desktopWorkspaceCreateInputSchema.parse(input))),
        rename: async input => {
            const parsed = desktopWorkspaceRenameInputSchema.parse(input)
            if (!bridge) return desktopWorkspaceRenameResultSchema.parse(await call('rename', parsed))
            const listed = desktopWorkspaceListResultSchema.parse(await bridge.list())
            const active = listed.catalog.workspaces.find(workspace => workspace.workspaceId === listed.selection.workspaceId)
            if (!active || active.workspaceId !== parsed.workspaceId) return { ok: false, code: 'not_found', message: 'Open that workspace before changing its settings.' }
            const hasIcon = Object.prototype.hasOwnProperty.call(parsed, 'iconCatalogId')
            const response = await fetch(hasIcon ? '/api/desktop/workspace/icon' : '/api/desktop/settings', {
                method: hasIcon ? 'PUT' : 'PATCH', headers: { 'content-type': 'application/json' },
                body: JSON.stringify(hasIcon ? { name: parsed.name, catalogId: parsed.iconCatalogId } : { action: 'workspace', name: parsed.name }), credentials: 'same-origin',
            })
            if (!response.ok) throw new Error('Workspace settings could not be saved.')
            const { flushDesktopWorkspaceMetadata } = await import('./metadata')
            await flushDesktopWorkspaceMetadata().catch(() => {})
            return desktopWorkspaceRenameResultSchema.parse({ ok: true, workspace: { ...active, name: parsed.name, ...(hasIcon ? { iconCatalogId: parsed.iconCatalogId } : {}) } })
        },
        switchTo: async input => {
            const parsed = desktopWorkspaceSwitchInputSchema.parse(input), result = desktopWorkspaceSwitchResultSchema.parse(await call('switchTo', parsed))
            if (result.ok && (result.receipt.requestId !== parsed.requestId || result.receipt.toWorkspaceId !== parsed.workspaceId || result.workspace.workspaceId !== parsed.workspaceId)) throw new Error('The workspace switch acknowledgement changed.')
            return result
        },
        recoverSwitch: async input => {
            const parsed = desktopWorkspaceSwitchInputSchema.parse(input), result = desktopWorkspaceSwitchResultSchema.parse(await call('recoverSwitch', parsed))
            if (result.ok && (result.receipt.requestId !== parsed.requestId || result.receipt.toWorkspaceId !== parsed.workspaceId || result.workspace.workspaceId !== parsed.workspaceId)) throw new Error('The workspace recovery acknowledgement changed.')
            return result
        },
    }
}
