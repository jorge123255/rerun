/**
 * Template content lock for trigger prompts — original seals only the prompt.
 * Hosted billing unlock is root-dependent; this adapter takes an injected locked flag and optional
 * unlock callback instead of importing the hosted billing store.
 */

export type DesktopTriggerTemplateLockState = {
    locked: boolean
    subject: string
    /** When omitted while locked, the UI shows an honest unavailable unlock path. */
    onUnlock?: () => void
    unlockLabel?: string
}

export function desktopTriggerPromptLock(locked: boolean, onUnlock?: () => void): DesktopTriggerTemplateLockState {
    return {
        locked,
        subject: 'trigger prompts',
        onUnlock,
        unlockLabel: onUnlock ? 'Upgrade to unlock' : undefined,
    }
}
