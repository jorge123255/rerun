import { desktopVaultSignInExpiredMessage, type DesktopVaultEntry, type DesktopVaultHealthReceipt } from '@/lib/desktop/vault'

export function vaultAccountHealthText(health?: DesktopVaultHealthReceipt, signedOut?: boolean): string {
    if (signedOut) return 'Sign-in required'
    if (health?.state === 'healthy') return 'Connected (last check)'
    if (health?.state === 'disconnected') return 'Sign-in required'
    if (health?.state === 'error') return 'Connection check failed'
    return 'Connection not checked'
}

export type VaultStatus = { label: string; tone: 'orange' | 'red' | 'neutral' }

/**
 * The badge a Vault entry wears, after upstream's VaultStatusBadge. "Signed out" is upstream's word.
 * "Sign-in expired", "Key rejected" and "Check failed" are the Mac's: its connection check tells
 * them apart and upstream has no word for them. An entry that was never checked, or whose last check
 * passed, wears none, as on the cloud. Upstream's "Not set up" has no Mac state behind it.
 */
export function vaultEntryStatus(entry: DesktopVaultEntry): VaultStatus | null {
    if (!('kind' in entry) || entry.kind !== 'mcp') return null
    const health = entry.catalog?.health
    if (entry.signedOut || health?.state === 'disconnected') return { label: 'Signed out', tone: 'orange' }
    if (health?.credentialRejected) return { label: 'Key rejected', tone: 'red' }
    if (health?.state === 'error') return health.message === desktopVaultSignInExpiredMessage
        ? { label: 'Sign-in expired', tone: 'orange' } : { label: 'Check failed', tone: 'neutral' }
    return null
}

/** The app's name for an app account; the entry's own name for everything else. */
export function entryName(entry: DesktopVaultEntry): string {
    return 'kind' in entry && entry.kind === 'mcp' ? entry.catalog?.name ?? entry.name : entry.name
}

/** The label an app account was given, when it has one. */
export function entryLabel(entry: DesktopVaultEntry): string | undefined {
    return 'kind' in entry && entry.kind === 'mcp' ? entry.catalog?.label : undefined
}

export function entryTitle(entry: DesktopVaultEntry): string {
    return entryLabel(entry) ?? entryName(entry)
}

export function entrySubtitle(entry: DesktopVaultEntry): string {
    if (!('kind' in entry)) return entry.variable
    if (entry.kind === 'program') return entry.executable
    return entry.catalog?.label ? entry.catalog.name + ' · ' + entry.url : entry.url
}

export type VaultEntryGroup = 'app' | 'mcp' | 'program' | 'secret'

export function entryGroup(entry: DesktopVaultEntry): VaultEntryGroup {
    if (!('kind' in entry)) return 'secret'
    if (entry.kind === 'program') return 'program'
    return entry.catalog ? 'app' : 'mcp'
}

export const VAULT_GROUP_LABEL: Record<VaultEntryGroup, string> = { app: 'App', mcp: 'MCP server', program: 'Local program', secret: 'Secret' }
