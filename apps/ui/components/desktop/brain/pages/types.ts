import type { BrainDraftActions, BrainDraftWriteResult, BrainPageDetail } from '@/lib/desktop/use-brain-page-draft'
import type { BrainPageSummary, BrainRevision } from '@rerun/contracts'

/**
 * What the desktop Brain panel needs from the store behind it, shaped like the original brain
 * actions so a page, a history screen and an autosave do not know which is mounted.
 *
 * Root injects the implementation (G owns the routes and the store). This lane never imports a
 * server action, never reads the engine directly, and never invents a page when a call fails.
 */
export type DesktopBrainOverview =
    | { available: true; pages: BrainPageSummary[]; openProposals: number }
    /** `outdated` means the box answers but predates the Brain; the panel says so instead of guessing. */
    | { available: false; reason: 'no_machine' | 'outdated' | 'unreachable' }

export type DesktopBrainDeleteResult = { ok: true } | { ok: false; error: string }

export type DesktopBrainRevision = { revision: BrainRevision; content: string }

export type DesktopBrainActions = BrainDraftActions & {
    overview: () => Promise<DesktopBrainOverview>
    deletePage: (slug: string) => Promise<DesktopBrainDeleteResult>
    readRevision: (slug: string, revisionId: string) => Promise<DesktopBrainRevision | null>
    /** `expectedHash` refuses the restore when the page moved since it was read. */
    restoreRevision: (slug: string, revisionId: string, expectedHash?: string) => Promise<BrainDraftWriteResult>
}

export type DesktopBrainSelection =
    | { kind: 'page'; slug: string }
    | { kind: 'history'; slug: string }
    | { kind: 'new-page' }
    | { kind: 'proposals' }

export type { BrainDraftWriteResult, BrainPageDetail }
