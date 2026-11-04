# Agent G — D7: desktop private and shared data

Branch `desktop/coworker-data-tables`, prepared base `927c5e17da6b6db84657261695a98e0533b264de`; original reference `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

This is source for root integration, not an acceptance report. The worktree already contained an uncommitted port when this task resumed; this delivery completes and hardens that lane's files. No live database, app, credentials or other worktree was opened or changed.

## Original source and reuse

Read `apps/ui/components/agent/AgentPanelData.tsx`, `components/data/SharedDataPanel.tsx`, `DataBrowser.tsx`, `DataBrowserToolbar.tsx`, `views/ViewBoard.tsx`, `ViewGallery.tsx`, `ViewList.tsx`, and `lib/data/source.ts`. The desktop wrappers reuse those original DataBrowser/view components, with the narrow export and lifecycle corrections documented below, including filters, row editing, view selection, export, and row/purge/table confirmation dialogs. Private expansion preserves the original full-size dialog; shared data gains the same expansion because its desktop entry is a dialog.

Read `apps/engine/src/http/routes/data.ts`, `db/sqlStore.ts`, `db/tableViews.ts`, `db/agentDb.ts`, `db/sharedDb.ts`, `tools/builtin/db.ts`, `tools/builtin/shared-db.ts`, and the installed local libsql transaction implementation. Upstream db_query uses assertNoAttach; it is not a read-only enforcement boundary and is not exposed here. Upstream queryStore also materializes all rows before slicing; desktop queries enforce an outer SQL LIMIT instead.

Applicable `apps/ui/AGENTS.md` and installed Next.js route documentation at `../final-build/apps/ui/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` read. New Next routes use asynchronous params, Node runtime and existing desktop authentication.

## Changed source

- `apps/engine/src/desktop/data-tools.ts`: independent db/sharedDb grants, original six tool names, current-config checks under agent lock, lifecycle lease and pre-commit cancellation/grant check.
- `apps/engine/src/desktop/sql-guard.ts`: quoted/comment-aware single-statement parsing, all `_rerun_*`/`sqlite_*` names blocked, file/extension function allowlist and explicit table/row write grammar.
- `apps/engine/src/desktop/data-store.ts`: actual query-only SQLite transaction connections, SQL-level row cap, atomic write batches, filtered schema and pre-existing schema-program rejection.
- `apps/engine/src/desktop/data-router.ts`: desktop-only wrapper around original DataRouter, no raw SQL endpoints, transaction per operation, atomic UPDATE RETURNING, atomic table/view cleanup and bounded exports.
- `apps/ui/components/desktop/DesktopCoworkerData.tsx`, `DesktopSharedData.tsx`: original browser/views in private/shared dialogs.
- `apps/ui/lib/desktop/data-scope.ts`, `data-source.ts`, `data-views.ts`: fixed-scope DataSource adapters, per-scope remembered views, authenticated exports, saved view CRUD, groups and row edits.
- `apps/ui/lib/desktop/server/coworker-data.ts`: roster mapping, bounded/validated requests, internal-table filtering, truthful engine errors.
- `apps/ui/app/api/desktop/agents/[agentId]/data/[[...path]]/route.ts`, `apps/ui/app/api/desktop/shared-data/[[...path]]/route.ts`: authenticated explicit routes; no database selector in input and no generic SQL.
- Regression sources: engine `data-tools.test.ts`, `sql-guard.test.ts`, `data-router.test.ts`; UI `server/coworker-data.test.ts`. Not executed.

## Root integration now present

Root integrated exact Agent G handoff `925dead9ac7e30c41cd0f01bfb723f0b570cb69b`, retaining the original components and existing private/shared database paths. This section supersedes the lane's proposed snippets. Native acceptance remains pending.

- `http/server.ts` mounts `createDesktopDataRouter` for desktop private/shared prefixes. Both client factories call `prepareDesktopDataFile(dataDir(), path)` before any SQLite initializer and verify the returned identity afterward. Hosted routes retain their original implementation. Explicit desktop route policy permits browser operations, never raw SQL HTTP endpoints.
- Contracts and the desktop registry expose `db_query`, `db_execute`, `db_schema` and their three `shared_db_*` counterparts under independent, default-off `db` and `sharedDb` grants. Failures throw tool errors; they are not successful strings containing an error message.
- The system prompt derives database access from those desktop grants and asks the coworker to inspect schema through its authorized tool. It does not open a database automatically for an upstream prompt schema dump or advertise table cards. Shared creator metadata is advisory, not an ownership permission.
- The original Database tab opens `DesktopCoworkerData` from chat and Control Center. The workspace menu opens `DesktopSharedData` with controlled modal/focus handling; its `hideTrigger` prop suppresses a duplicate trigger.
- The original DataBrowser receives a narrow optional `DataSource.exportFile` hook. Hosted export behavior remains intact. Desktop fetches the authenticated local export with a 5 MB streaming cap and abort support, then initiates a named Blob download without opening an external window. Native export acceptance is required.
- Async row/view/table results are scoped to the initiating source and table. A delayed result must not modify another table or a reopened editor; successfully saved backend changes remain available when the owner is revisited.

## Model SQL execution boundary

`data-executor.ts` and `data-worker.ts` put model SQL in an isolated child using the bundled Node executable and adjacent compiled `data-worker.js`. There is no inherited credential environment or model-selected executable/path. Filesystem-only preflight validates the root, each parent, database and journal paths before initialization. Missing ordinary paths are created with restrictive permissions. All model SQLite initialization, shared migrations and query/write work run inside the child.

The parent enforces a 10-second execution deadline and terminates/reaps the child on Stop before releasing the coworker lock. Waiting for the same coworker's lock is separately cancellable and bounded; a cancelled queued callback cannot run later. Input is capped at 1 MB, output at 60 KB, query output at 49 KB and 200 rows, schema at 8 KB. The child has a 128 MiB V8 heap limit, which is not an OS-wide native-memory quota. Allocation-heavy unneeded SQL functions are excluded.

Writes use a transaction and a pre-commit handshake: the parent rechecks current permission, cancellation and file identity before authorizing commit. Losing the acknowledgement after permission reports an unknown outcome and never retries automatically. Batches roll back on statement failure. Shared creator metadata is updated within the same transaction. Human browser routes use explicit bounded operations in the engine process; the worker boundary specifically covers model-supplied SQL.

## Deliberate differences, security and limits

- Private storage stays in the engine's existing per-agent data file. Shared storage stays in its existing workspace data file. Browser agent IDs map through the local roster to immutable engine IDs. No external connectors, public sharing or credential import.
- SQLite itself enforces query_only on a detached transaction connection; the pooled writer is not toggled. SQL is one SELECT/WITH subquery with an outer LIMIT of requested cap+1, max 200. Result text stays under 50k characters, explicitly marking omitted data without claiming to know the full row count. SQL max 20k chars, max 500 params (strings max 50k), writes max 100 statements, XOR single/batch input.
- SQL parser rejects stacked statements, ATTACH/DETACH, PRAGMA (including pragma_* virtual functions), VACUUM, transaction commands, file functions, unlisted extension functions and all internal identifiers, including SQLite's single-quoted table-name syntax. Table/row changes only; RETURNING is unavailable to model SQL because result rows could otherwise be unbounded. The browser's internal, parameterized UPDATE RETURNING returns its actual updated row even when INTEGER PRIMARY KEY changes.
- Schema programs (pre-existing views, triggers or virtual tables) cause desktop data operations to fail closed. They can indirectly reach internal data or execute functions; no attempt is made to run/repair them. This conservative limitation and the built-in function allowlist intentionally narrow general SQLite compatibility. A string literal exactly matching an internal name is also rejected conservatively. The isolated worker provides a wall-clock bound for model queries; row and retained output limits alone are not a query-complexity or native-memory guarantee.
- Each tool re-reads its exact grant under the config lock before acting. Writes recheck cancellation/grant before commit. Lifecycle lease prevents deletion while a tool is operating. Row/table/view browser operations commit as a transaction before a success response; failure rolls back. Actual SQLite row/statement counts determine write acknowledgements. Shared creator tracking is best-effort advisory metadata and never an ownership check; metadata recording failure does not misreport a committed data change as failure.
- Authenticated human browser operations allow at most 200 rows/page, eight filters, 200-character terms, offset max 1m, 500 row IDs/delete and 64 columns/update. Internal names are refused before proxy calls. Exports cap at 10k matching rows and 5 MB; overflow returns a truthful error, never a silently partial file. CSV formula-looking strings are escaped as text; filenames are encoded and headers prohibit caching/sniffing. Export limits bound materialized row count and encoded output, not the bytes of one existing cell before decoding.
- Saved views use existing per-database `_rerun_views`; the remembered view key also distinguishes each private coworker from shared scope. Board uses original 50-group limit. Gallery uses the existing authenticated private Files image route; shared scope has no file resolver. No card_table, external database, new connectors, public sharing or credential import.
- New wrappers preserve the original DataBrowser view layouts. Shared copy clarifies that coworker access requires its grant. Table creation/population happens through coworker *_execute; the browser manages existing rows/tables/views.

## Validation status

Authored regressions cover grant separation/revocation, actual private/shared isolation, read-only and quoted hidden-table guards, extension/file SQL, stacked statements, atomic batch rollback, result caps, exact write input bounds, roster routing, explicit browser operations, malformed views and transaction-bound primary-key edits. Root must run them and the policy/auth/UI regressions, including all four views, confirmations/cancellation, saved-view persistence after restart, full exports/overflow, and real Codex create/populate/query replies.

**Tests, type checks, lint, builds, packaging, installs, live model requests and Mac/restart acceptance were not run by this lane.** No installed app control, live database modifications, push or merge. Root owns integration and every execution/acceptance check.
