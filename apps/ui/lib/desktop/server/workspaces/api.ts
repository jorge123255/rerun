import 'server-only'
import {
    desktopWorkspaceCreateInputSchema,
    desktopWorkspaceRenameInputSchema,
    desktopWorkspaceSwitchInputSchema,
    type DesktopWorkspaceCreateResult,
    type DesktopWorkspaceListResult,
    type DesktopWorkspaceRenameResult,
    type DesktopWorkspaceSwitchResult,
} from '@rerun/contracts'
import { createDesktopWorkspaceAdapters } from './adapters'
import { MissingDesktopWorkspaceAuthority, type DesktopWorkspaceServerPorts } from './ports'

export type DesktopWorkspaceHandlers = {
    list: () => Promise<DesktopWorkspaceListResult | { ok: false; code: 'authority_missing'; message: string; authority: string }>
    create: (body: unknown) => Promise<DesktopWorkspaceCreateResult | { ok: false; code: 'authority_missing'; message: string; authority: string }>
    rename: (body: unknown) => Promise<DesktopWorkspaceRenameResult | { ok: false; code: 'authority_missing'; message: string; authority: string }>
    switchTo: (body: unknown) => Promise<DesktopWorkspaceSwitchResult | { ok: false; code: 'authority_missing'; message: string; authority: string }>
    reconcile: () => Promise<DesktopWorkspaceListResult & { requiresManualRecovery?: boolean } | { ok: false; code: 'authority_missing'; message: string; authority: string }>
}

function authorityMissing(error: unknown) {
    if (error instanceof MissingDesktopWorkspaceAuthority) {
        return {
            ok: false as const,
            code: 'authority_missing' as const,
            message: `Switching workspaces needs a missing app capability (${error.authority}).`,
            authority: error.authority,
        }
    }
    throw error
}

export function desktopWorkspaceHandlers(ports: DesktopWorkspaceServerPorts): DesktopWorkspaceHandlers {
    const adapters = createDesktopWorkspaceAdapters(ports)
    return {
        async list() {
            try { return await adapters.list() }
            catch (error) { return authorityMissing(error) }
        },
        async create(body) {
            const parsed = desktopWorkspaceCreateInputSchema.safeParse(body)
            if (!parsed.success) return { ok: false, code: 'unsupported', message: 'That workspace could not be created.' }
            try { return await adapters.create(parsed.data) }
            catch (error) { return authorityMissing(error) }
        },
        async rename(body) {
            const parsed = desktopWorkspaceRenameInputSchema.safeParse(body)
            if (!parsed.success) return { ok: false, code: 'unsupported', message: 'That workspace could not be renamed.' }
            try { return await adapters.rename(parsed.data) }
            catch (error) { return authorityMissing(error) }
        },
        async switchTo(body) {
            const parsed = desktopWorkspaceSwitchInputSchema.safeParse(body)
            if (!parsed.success) return { ok: false, code: 'unsupported', message: 'That workspace switch could not be started.' }
            try { return await adapters.switchTo(parsed.data) }
            catch (error) { return authorityMissing(error) }
        },
        async reconcile() {
            try { return await adapters.reconcile() }
            catch (error) { return authorityMissing(error) }
        },
    }
}
