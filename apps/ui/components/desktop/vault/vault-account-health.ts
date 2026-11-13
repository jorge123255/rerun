import type { DesktopVaultHealthReceipt } from '@/lib/desktop/vault'

export function vaultAccountHealthText(health?: DesktopVaultHealthReceipt, signedOut?: boolean): string {
    if (signedOut) return 'Sign-in required'
    if (health?.state === 'healthy') return 'Connected (last check)'
    if (health?.state === 'disconnected') return 'Sign-in required'
    if (health?.state === 'error') return 'Connection check failed'
    return 'Connection not checked'
}
