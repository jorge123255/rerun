# D8 Company Brain pages — source handoff

Lane: `desktop/round28-brain-pages`, prepared base `15dce4a9dcefeb95b0042d01d8b2afc9bbe5c3f6`.
Original source pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

Source prepared only. No tests, type checks, lint, builds, packaging, installs, live model requests, external-service calls, app servers, installed-app changes, live workspace/Keychain access, or native/restart QA were run. Root execution and native acceptance are pending. This handoff does not mark D8 accepted.

## Original implementation reused

Read with `git show` at the original pin before editing:

- `apps/engine/src/http/routes/brain.ts`: page collection/detail/write/delete, revision reads, revert and confirmation routes; original detail response includes revisions.
- `apps/engine/src/brain/pages.ts`: Markdown/frontmatter source of truth; title/type/content hash; per-author ten-minute autosave revision merging; retained history on delete; seed confirmations; card ordering, links and backlinks.
- `apps/engine/src/db/brainDb.ts`: existing `brain_pages`, `brain_chunks`, `brain_chunks_fts`, `brain_links`, `brain_revisions`, and original migration ladder. No replacement page model or new SQL schema.
- `apps/ui/app/api/_actions/brain.actions.ts`: action names, write-result union, overview shape, and server-owned author.
- Supporting unchanged code: `packages/contracts/src/brain.ts`, engine `brain/chunks.ts` and `brain/links.ts`.

Those four requested original files are unchanged between the source pin and prepared base. The desktop adapter reuses their storage layout and contracts, and directly reuses chunk/link/hash primitives. Original `pages.ts` cannot be called for writes because it unconditionally schedules hosted embeddings, has globally bound storage, and permits unguarded restores; its relevant store logic is isolated in the additive desktop module instead. No UI/layout was created or changed; H retains the original Brain design.

## Mac adaptations

- Next routes authenticate with `desktopRoute` before resolving requested paths. The local engine is addressed only using authenticated `DesktopRuntime.engine.origin`; bearer headers never reach redirects (`redirect: 'error'`). No workspace ID, engine URL, filesystem path, author, `force`, or proposal identity is accepted from the browser.
- The engine assigns `user:local-profile-1`, the existing desktop single-profile server identity. Browser input cannot select another author. Multi-profile support would need an authenticated server identity resolver before widening this assumption.
- Brain files live in the original engine `brain/` and `brain-db/brain.db`, outside shared files and coworker-private Memories. Requests fail when storage is absent/unavailable; they do not initialize storage or return empty success on errors. Missing page/revision is HTTP 404, not a null success. The initial empty, initialized Brain legitimately lists zero pages.
- Store operations serialize per canonical Brain directory. Writes atomically rename a 0600 temporary Markdown file; index/history updates share one SQLite transaction. In-process failures roll back the DB and restore the prior file. Same-author autosaves retain revision identity inside the original merge window. Restore always requires a current 32-character hash and creates a separate revision when content changes. Delete retains revision rows, which remain readable using slug plus revision ID. Explicit recreation starts a new revision instead of merging into deleted-page history.
- Original title/content/type/source limits remain; slugs are bounded lowercase kebab-case. JSON is capped at 300,000 bytes before parsing, with body-read deadlines, and engine responses at 2,000,000 bytes. Page reads are bounded at 512,000 bytes; lists at 1,000 pages/backlinks, revision lists at the original 50. Symlink/nonregular/hardlinked page files and aliased storage directories fail closed. Existing DB/journal identity protection is reused before opening SQLite and before each operation.
- Indexing uses the existing chunker, links and FTS5 tables only. No vector is requested; no embedding, seeding, website fetch, search provider or model-tool module is invoked by these operations. `rebuildLocalIndex()` rebuilds only derived local tables and preserves revisions/proposals. Upstream desktop scheduler already skips `maintainBrainIfDue()` behind `!desktopApp()`; keep that guard.
- Read failures reject. Save/restore/confirm/delete retain the original explicit failure-result shape. Overview requires D's real proposal count; it never substitutes zero for a failed proposal request.

## Root integration: engine registration and policy

In `apps/engine/src/http/server.ts`, inside the authenticated API registration, before the existing `api.route('/desktop', desktopRoutes)` mount:

```ts
import { createDesktopBrainPagesRouter } from '../desktop/brain-pages-router.js'

if (desktopApp()) api.route('/desktop/brain/pages', createDesktopBrainPagesRouter())
```

Keep the existing bearer middleware before this mount. Keep hosted `/brain` routes inaccessible in desktop policy. Do not register Brain model tools, enable hosted search, or seed the Brain.

In `apps/engine/src/desktop/policy.ts`, before its general method fallthrough:

```ts
import { desktopBrainPagesRouteAllowed } from './brain-pages-policy.js'

if (desktopBrainPagesRouteAllowed(method, path)) return true
```

The helper admits exactly collection GET; item GET/PUT/DELETE; revision-list/read GET; guarded revert POST; and confirmation POST. Other Brain operations remain denied by the existing policy.

## Root integration: numbered initialization step

Requests deliberately refuse to create missing storage. Root must append a new data-dir migration before exposing the panel. At this base the next number is 4; allocate the next unused number after merging concurrent migrations. Reuse the existing Brain DB ladder, rather than adding Brain tables to `app.db`.

Additional imports for `apps/engine/src/datadir/migrations.ts` (reuse existing `mkdir` import):

```ts
import { brainDir, brainDbPath, dataDir } from '../config/paths.js'
import { getBrainDb } from '../db/brainDb.js'
import { desktopApp } from '../desktop/policy.js'
import { assertDesktopBrainDirectory, createDesktopBrainPagesStore } from '../desktop/brain-pages.js'
import { prepareDesktopDataFile, verifyDesktopDataFile } from '../desktop/data-executor.js'
```

Append to `DATA_DIR_MIGRATIONS`, without rewriting shipped steps:

```ts
{
    version: 4,
    id: 'desktop-brain-pages',
    up: async () => {
        if (!desktopApp()) return
        await mkdir(brainDir(), { recursive: true, mode: 0o700 })
        await assertDesktopBrainDirectory(brainDir())
        const pin = await prepareDesktopDataFile(dataDir(), brainDbPath())
        const database = await getBrainDb()
        await verifyDesktopDataFile(pin)
        await createDesktopBrainPagesStore(brainDir(), async () => {
            await verifyDesktopDataFile(pin)
            return database
        }).rebuildLocalIndex()
    },
},
```

Root must author/run the migration regression from previous data-dir version, with existing Markdown and retained revisions, and verify idempotence. If original Brain files are imported or manually edited later, explicitly run the same local rebuild under root's recovery flow; do not call upstream hosted maintenance. Subsequent missing/corrupt storage must remain an error, not trigger request-time initialization.

## H/root injected action interface

Client exports are in `apps/ui/lib/desktop/brain-pages.ts`; the Next route files are self-contained. No central UI edit is needed in this lane. Original shared contracts are imported directly.

```ts
export type BrainPageInput = {
    title: string
    type: BrainPageType
    content: string
    sources: string[]
    baseHash: string | null
}
export type BrainPageDetail = { page: BrainPage; revisions: BrainRevision[] }
export type BrainWriteResult =
    | { ok: true; detail: BrainPageDetail }
    | { ok: false; conflict: boolean; error: string }
export type DesktopBrainPagesActions = {
    listBrainPagesAction(): Promise<BrainPageSummary[]>
    readBrainPageAction(slug: string): Promise<BrainPageDetail>
    saveBrainPageAction(slug: string, input: BrainPageInput): Promise<BrainWriteResult>
    deleteBrainPageAction(slug: string): Promise<{ ok: boolean; error?: string }>
    listBrainRevisionsAction(slug: string): Promise<BrainRevision[]>
    readBrainRevisionAction(slug: string, revisionId: string): Promise<{ revision: BrainRevision; content: string }>
    revertBrainPageAction(slug: string, revisionId: string, expectedHash: string): Promise<BrainWriteResult>
    confirmBrainSectionsAction(slug: string, headings: string[] | null): Promise<BrainWriteResult>
}
export type DesktopBrainOverview = {
    available: true
    pages: BrainPageSummary[]
    openProposals: number
}
```

Root/H can construct the original overview action with D's actual authenticated proposal count:

```ts
import { createDesktopBrainPagesActions, type DesktopBrainOverview, type DesktopBrainPagesActions } from '@/lib/desktop/brain-pages'

function wireBrainPageActions(countOpenProposals: () => Promise<number>):
    DesktopBrainPagesActions & { loadBrainAction(): Promise<DesktopBrainOverview> } {
    return createDesktopBrainPagesActions(countOpenProposals)
}
```

Pass this action object into H's injected interface, alongside D's proposal actions. Do not import hosted `brain.actions.ts` at runtime for desktop. H must pass `open.page.hash` as the third argument when restoring; the original two-argument history restore must be adapted. H must render rejected read/history/overview requests as errors, and inspect `ok` on write/delete results. Never convert request failures into an empty Brain or an absent revision. Do not expose website seed UI for this capability.

## Dependencies and remaining limits

- Only root can enable the engine route/policy and initialize persistent storage. Until then the UI routes return an error. D supplies proposal actions/count; H supplies UI injection and current-hash restore behavior. No files belonging to those lanes were edited.
- D must serialize its local proposal-to-page writes with the exported `withDesktopBrainPagesLock<T>(directory: string, action: () => Promise<T>): Promise<T>` and preserve the local-only index policy. Do not nest this lock around a store method, which already takes it. Do not use upstream `writePage` from a desktop proposal accept path, because that schedules hosted embeddings.
- Existing dependencies only: contracts/Zod, Hono, gray-matter, libsql and Node filesystem primitives. No installs or new dependency manifests.
- Locks coordinate this single engine process, not another engine or an external editor. Root must prevent two engines from owning one data directory. Rename plus SQLite rollback protects ordinary failures, but is not a distributed filesystem/SQLite crash transaction; a hard crash between rename and DB commit can require local index reconciliation. Revision identities are never fabricated during rebuild. No hard-crash acceptance claim is made.
- Deletion matches the original API (no extra delete hash). Deleted page history is readable, while restore requires an existing page and its current hash; deleted-page resurrection is not added.
- Embeddings, hosted search, seeding, model tools, proposals and UI changes are outside this lane. D8 is not accepted until root integrates and executes source checks plus native/restart QA.

## Source files and root checks

Changed files (all new/additive):

- `apps/engine/src/desktop/brain-pages.ts`
- `apps/engine/src/desktop/brain-pages-router.ts`
- `apps/engine/src/desktop/brain-pages-policy.ts`
- `apps/engine/src/desktop/brain-pages.test.ts`
- `apps/ui/lib/desktop/brain-pages.ts`
- `apps/ui/lib/desktop/brain-pages.test.ts`
- `apps/ui/lib/desktop/server/brain-pages.ts`
- `apps/ui/app/api/desktop/brain/pages/[[...path]]/route.ts`
- `apps/ui/app/api/desktop/brain/pages/[[...path]]/route.test.ts`
- `docs/desktop-round28-brain-pages-handoff.md`

Regression sources cover local FTS/no network, private-memory sentinel, concurrent conflicts, restore/history identity, retained delete history, DB rollback, local index rebuild, invalid paths and forged authors, storage errors, policy confinement, desktop authentication/origin checks, input/output bounds, strict restore guards and failing proposal overview dependencies. These sources have not been executed. Root should run them after integration, existing original Brain regressions, type/lint/build checks, the new migration regression, and native create/edit/conflict/history/restore/delete/restart QA. Confirm no request to hosted `/api/embed` during any desktop operation.
