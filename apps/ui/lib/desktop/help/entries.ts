import { isDesktopForemanDocsCitation, RERUN_PUBLIC_DOCS_CORPUS } from '@rerun/contracts'
import { docsUrl, landingUrl } from '@/lib/site'

/** Copied from HelpMenuItems. Not a new destination. */
export const DESKTOP_HELP_COMMUNITY_URL = 'https://discord.gg/cJUUgdTg5p'
export const DESKTOP_HELP_EXPERTS_PATH = '/community/experts'

/** Hosted surfaces this dialog does not open. */
export const DESKTOP_HELP_GATED_IDS = ['whats_new', 'contact_support', 'install_app', 'weekly_rewind'] as const

export type DesktopHelpEntry =
    | { id: 'getting_started'; kind: 'getting_started'; label: 'Getting started' }
    | { id: 'docs'; kind: 'link'; label: 'Docs'; href: string }
    | { id: 'community'; kind: 'link'; label: 'Community'; href: string }
    | { id: 'shortcuts'; kind: 'shortcuts'; label: 'Shortcuts' }
    | { id: 'experts'; kind: 'link'; label: 'Hire an expert'; href: string }

function approvedDocsUrl(): string | null {
    const href = docsUrl()
    if (href !== RERUN_PUBLIC_DOCS_CORPUS.documentation || !isDesktopForemanDocsCitation(href)) return null
    return href
}

/**
 * Local help rows. Getting started stays listed after dismiss so it can be reopened.
 * A failed checklist read passes gettingStarted false. Shortcuts appears only when the
 * Mac dialog callback exists. What's new, support chat, install, and rewind are absent.
 */
export function desktopHelpEntries(options: { gettingStarted: boolean; shortcuts: boolean }): DesktopHelpEntry[] {
    const docs = approvedDocsUrl()
    const entries: Array<DesktopHelpEntry | false> = [
        options.gettingStarted && { id: 'getting_started', kind: 'getting_started', label: 'Getting started' },
        !!docs && { id: 'docs', kind: 'link', label: 'Docs', href: docs },
        { id: 'community', kind: 'link', label: 'Community', href: DESKTOP_HELP_COMMUNITY_URL },
        options.shortcuts && { id: 'shortcuts', kind: 'shortcuts', label: 'Shortcuts' },
        { id: 'experts', kind: 'link', label: 'Hire an expert', href: landingUrl(DESKTOP_HELP_EXPERTS_PATH) },
    ]
    return entries.filter((entry): entry is DesktopHelpEntry => entry !== false)
}

/** The checklist popover treats the dialog's return-focus as a click outside and closes. */
export function desktopHelpKeepsFocus(action: DesktopHelpEntry['kind'] | 'close'): boolean {
    return action === 'getting_started'
}
