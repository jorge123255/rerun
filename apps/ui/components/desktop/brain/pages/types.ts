import type { BrainDraftWriteResult, BrainPageDetail } from '@/lib/desktop/use-brain-page-draft'
import type { DesktopBrainPagesActions, BrainDeleteResult, DesktopBrainOverview as PagesOverview } from '@/lib/desktop/brain-pages'
import type { BrainRevision } from '@rerun/contracts'

/**
 * What the desktop Brain panel needs from the store behind it, shaped like the original brain
 * actions so a page, a history screen and an autosave do not know which is mounted.
 *
 * Root injects the implementation (G owns the routes and the store). This lane never imports a
 * server action, never reads the engine directly, and never invents a page when a call fails.
 */
export type DesktopBrainOverview =
    | ({ available: true } & PagesOverview)
    /** `outdated` means the box answers but predates the Brain; the panel says so instead of guessing. */
    | { available: false; reason: 'no_machine' | 'outdated' | 'unreachable' }

export type DesktopBrainDeleteResult = BrainDeleteResult

export type DesktopBrainRevision = { revision: BrainRevision; content: string }

export type DesktopBrainActions = DesktopBrainPagesActions

export type DesktopBrainSelection =
    | { kind: 'page'; slug: string }
    | { kind: 'history'; slug: string }
    | { kind: 'new-page' }
    | { kind: 'proposals' }

export type { BrainDraftWriteResult, BrainPageDetail }
