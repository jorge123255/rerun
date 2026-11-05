# Desktop Company Brain editor and version history

Source for the Mac Company Brain panel: the hosted sidebar, page editor, new-page screen and
version history, ported to a self-contained desktop panel over an injected actions interface.

**Not accepted, and not executed.** Root has not integrated this, no test, type check, lint, build,
packaging or Mac acceptance ran, and no app server or live workspace was touched. Everything below
is source-level.

## Original provenance

Original source pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. These files are byte-identical to
that pin in this worktree and were read before writing anything:

- `apps/ui/components/brain/BrainWorkspace.tsx`: the sidebar and main panel, selection, page reads,
  save/restore/delete plumbing, the ⌘K search.
- `apps/ui/components/brain/BrainSidebar.tsx`: the one tree, its sections, search and product fold.
- `apps/ui/components/brain/BrainPage.tsx`: the page column, autosave status, conflict banner,
  delete confirmation, backlinks.
- `apps/ui/components/brain/BrainNewPage.tsx`: the create-on-first-title screen.
- `apps/ui/components/brain/BrainPageHistory.tsx`: versions on the right, preview on the left,
  restore confirmation.
- `apps/ui/hooks/useBrainAutosave.ts`: debounce, base hash, conflict handling, the write that
  outlives a page being left.
- Reused unchanged, not copied: `components/brain/BrainPageParts.tsx`, `brain/editor/BrainEditor.tsx`,
  `brain/BrainTopBar.tsx`, `lib/brain/labels.ts`, `lib/brain/page-icons.ts`,
  `components/dialogs/ConfirmDialog.tsx`, `components/ui/panel-steps.tsx`.

## What this lane adds

| File | Role |
|---|---|
| `apps/ui/lib/desktop/use-brain-page-draft.ts` | Desktop autosave: injected actions, per-slug draft cache, conflict, flush, quit admission |
| `apps/ui/components/desktop/brain/pages/types.ts` | The injected actions interface and selection |
| `apps/ui/components/desktop/brain/pages/DesktopBrainPanel.tsx` | Sidebar plus main, selection, reads, delete/restore, empty and offline states |
| `.../DesktopBrainSidebar.tsx` | The hosted sidebar without the shared folder and database |
| `.../DesktopBrainPage.tsx` | Editor, autosave status, conflict, delete, history, backlinks |
| `.../DesktopBrainNewPage.tsx` | Create on first title, slug stability |
| `.../DesktopBrainHistory.tsx` | Versions, preview, restore confirmation |
| `.../DesktopBrainDialog.tsx` | Dialog framing, guarded close, draft flush |
| `.../index.ts` | Barrel for root |

## Injected actions

```ts
type DesktopBrainOverview =
    | { available: true; pages: BrainPageSummary[]; openProposals: number }
    | { available: false; reason: 'no_machine' | 'outdated' | 'unreachable' }

type DesktopBrainActions = {
    overview(): Promise<DesktopBrainOverview>
    readPage(slug: string): Promise<{ page: BrainPage; revisions: BrainRevision[] } | null>
    savePage(slug, write: { title; type; content; sources; baseHash }): Promise<
        { ok: true; detail } | { ok: false; conflict: boolean; error: string }>
    deletePage(slug): Promise<{ ok: true } | { ok: false; error: string }>
    readRevision(slug, revisionId): Promise<{ revision: BrainRevision; content: string } | null>
    restoreRevision(slug, revisionId, expectedHash?): Promise<BrainDraftWriteResult>
}
```

The shapes mirror `apps/ui/app/api/_actions/brain.actions.ts` and the `@rerun/contracts` brain
schemas (`BrainPage`, `BrainPageSummary`, `BrainRevision`, `BrainPageWrite`). Root adapts G's routes
and store to it once, in a client module, and the panel never learns where the data lives.

## Behavior kept from the original

- One sidebar tree with search, a Company section, a Pages section, a Products fold and New page.
- The page column: type icon, title, type select, sources, unconfirmed headings, last edited, body,
  backlinks, copy `[[slug]]`.
- Autosave a second after the last keystroke, against the hash the page was opened at.
- A refused write shows who changed the page, with Load their version or Keep mine.
- A failed write says it is not saved and offers Try again; it never shows Saved.
- New page writes nothing until a title exists, then keeps the slug its title gave.
- History: newest first, current marked, preview per version, restore behind a confirmation, Escape
  steps back to the page.
- Delete behind the original confirmation text; the list moves to the next page afterwards.

## Desktop adaptations, and why

1. **No shared folder, no shared database, no upload tray.** Those are separate surfaces in this
   build (`DesktopCoworkerFiles`, `DesktopSharedData`), and the hosted sidebar drew them beside the
   pages. The desktop sidebar keeps pages only; search searches pages.
2. **No website seeding.** `BrainSeedForm` is a hosted account flow. An empty Brain offers
   "Write the first page" instead.
3. **No proposal store.** The panel takes an optional `renderProposals` slot; without it the
   Proposals row and screen do not exist. D owns the review panel and its store.
4. **No confirm-sections action.** `confirmBrainSectionsAction` has no counterpart in the injected
   interface, so the unconfirmed headings are shown as badges with no Confirm button rather than a
   button that would do nothing.
5. **Drafts outlive the component.** The hosted hook kept the last save in a module map; this one
   keeps the draft text per slug, so switching page, opening history or reopening the dialog brings
   the unsaved text back, and the editor remounts on the draft rather than on the saved page.
6. **Write admission and quit.** A save holds `holdDraftAdmission()` until it settles, and
   `subscribeDraftShutdown` flushes every mounted page, so `flushDesktopDrafts()` on quit waits for
   brain writes the same way it waits for a composer draft.
7. **Guarded close.** `DesktopBrainDialog` awaits `flushDesktopBrainDrafts()` before closing and
   keeps the dialog open with a toast when a write could not land.

## Root integration fragments

```tsx
// Workspace menu or Control Center, wherever root mounts panels.
import { DesktopBrainDialog } from '@/components/desktop/brain/pages'
import { createDesktopBrainActions } from '@/lib/desktop/brain-actions' // root's adapter over G's routes

const actions = useMemo(() => createDesktopBrainActions(), [])
<DesktopBrainDialog actions={actions} renderProposals={proposalsMounted ? () => <ProposalsPanel /> : undefined} />
```

```tsx
// Mounted with dialog control, from a navigation request:
<DesktopBrainDialog hideTrigger actions={actions} dialogControl={{ open: brainOpen, onOpenChange: setBrainOpen }} />
```

```tsx
// Cross-panel navigation into a page (a coworker linked one, a proposal says a slug):
<DesktopBrainPanel actions={actions} openSlug={requestedBrainSlug} onOpenConsumed={() => setRequestedBrainSlug(null)} onClose={() => setBrainOpen(false)} />
```

```ts
// Quit: root's existing flush already covers it because the drafts registered themselves.
await flushDesktopDrafts() // brain writes are admitted and awaited through it
```

## Dependencies on other lanes

- **G (page routes and store):** `overview`, `readPage`, `savePage`, `deletePage`, `readRevision`,
  `restoreRevision`, with the original conflict contract (`ok: false, conflict: true` and a 409 from
  the route). No page is written by this lane.
- **D (proposal UI):** only as the `renderProposals` slot. The panel passes no proposal store and
  reads only `openProposals` for the count badge.
- **Root:** mounting, workspace menu, cross-panel navigation, the actions adapter, and packaging.

## Remaining limits

- No tests were authored or run for this lane; root runs the gates.
- The panel has no offline write queue: a failed save stays in the draft and is retried by the next
  edit, flush, close or quit.
- A page deleted elsewhere while open shows its last read; the next overview reload removes it.
- `expectedHash` on restore is passed when root's adapter accepts it; a store that ignores it still
  restores, and a conflict is surfaced by the result, not hidden.
- The confirm-sections action and the shared surfaces stay out of this panel until their own lanes
  provide them.
