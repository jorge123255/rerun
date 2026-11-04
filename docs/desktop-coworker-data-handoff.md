# Agent G — D7: desktop private and shared data

Branch `desktop/coworker-data-tables`, prepared base `927c5e17da6b6db84657261695a98e0533b264de`; original reference `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

This is source for root integration, not an acceptance report. The worktree already contained an uncommitted port when this task resumed; this delivery completes and hardens that lane's files. No live database, app, credentials or other worktree was opened or changed.

## Original source and reuse

Read `apps/ui/components/agent/AgentPanelData.tsx`, `components/data/SharedDataPanel.tsx`, `DataBrowser.tsx`, `DataBrowserToolbar.tsx`, `views/ViewBoard.tsx`, `ViewGallery.tsx`, `ViewList.tsx`, and `lib/data/source.ts`. The desktop wrappers reuse those original DataBrowser/view components unchanged, including filters, row editing, view selection, export, and row/purge/table confirmation dialogs. Private expansion preserves the original full-size dialog; shared data gains the same expansion because its desktop entry is a dialog.

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

## Root integration (shared files deliberately untouched)

### 1. Desktop engine router registration

In `apps/engine/src/http/server.ts`, import `createDesktopDataRouter` from `../desktop/data-router.js`. Keep hosted router registrations as they are. For desktop, use the new router at both existing prefixes:

```ts
api.route('/agents/:id/data', desktopApp()
    ? createDesktopDataRouter(c => {
        const id = c.req.param('id')!
        if (!agentExists(id)) throw notFound('agent')
        return getAgentDb(id)
    })
    : createDataRouter(c => {
        const id = c.req.param('id')!
        if (!agentExists(id)) throw notFound('agent')
        return getAgentDb(id)
    }, AGENT_HIDDEN_TABLES))
api.route('/shared/data', desktopApp()
    ? createDesktopDataRouter(() => getSharedDb())
    : createDataRouter(() => getSharedDb(), SHARED_HIDDEN_TABLES))
```

Use root's existing desktopApp import from `../desktop/policy.js`. Mount once per prefix; replacing just the policy is insufficient. The wrapper must remain behind existing engine authentication/desktop policy. No central UI database migration is added. Existing engine shared DB baseline and lazy `_rerun_views` storage are reused; root owns their schema registration.

### 2. Exact global policy additions (root only)

In `apps/engine/src/desktop/policy.ts`, after existing forbidden prefixes and `const id` and before generic method branches:

```ts
const data = `/(?:agents/${id}/data|shared/data)/tables`
const item = '[^/]+'
if (new RegExp(`^${data}$`).test(path)) return method === 'GET'
if (new RegExp(`^${data}/${item}$`).test(path)) return method === 'DELETE'
if (new RegExp(`^${data}/${item}/rows$`).test(path)) return method === 'GET' || method === 'DELETE'
if (new RegExp(`^${data}/${item}/rows/${item}$`).test(path)) return method === 'PATCH'
if (new RegExp(`^${data}/${item}/views$`).test(path)) return method === 'GET' || method === 'POST'
if (new RegExp(`^${data}/${item}/views/${item}$`).test(path)) return method === 'PUT' || method === 'DELETE'
if (new RegExp(`^${data}/${item}/(?:groups|export)$`).test(path)) return method === 'GET'
if (new RegExp(`^${data}/${item}/purge$`).test(path)) return method === 'POST'
```

Do not allow `/data/query` or `/data/execute`. Wrapper also returns 404 for these, independently of policy. Add policy regressions for both scopes, all explicit verbs, denied raw SQL, and denied verbs on unrelated route shapes.

### 3. Tool grants and registry

In `packages/contracts/src/desktop-tool-grants.ts`, add `db` and `sharedDb` to `desktopRerunGrantIds`; replace only their pending catalog rows:

```ts
supported('db', 'Private database', 'Read and change structured records in this coworker’s private database.', 'db_query', 'db_execute', 'db_schema'),
supported('sharedDb', 'Shared database', 'Read and change workspace shared records.', 'shared_db_query', 'shared_db_execute', 'shared_db_schema'),
```

Both default false. Neither implies the other. These are coworker capabilities; authenticated human browsing/editing uses the separate explicit browser adapter and is not granted implicitly to model tools.

In `apps/engine/src/tools/registry.ts`:

```ts
import { desktopDbTools, desktopSharedDbTools } from '../desktop/data-tools.js'
// Add only to desktopApp() early-return ToolSet:
...desktopDbTools(ctx),
...desktopSharedDbTools(ctx),
```

Keep original names; map their output through the existing Rerun tool presentation. Failure strings begin `Query failed:`, `Execution failed:` or `Schema read failed:`; denied/revoked actions do not return an OK acknowledgement. Native Codex SQL/shell capability policy is unchanged.

In root's system prompt integration (`apps/engine/src/agents/systemPrompt.ts`), derive desktop database access from `hasDesktopToolGrant(agent.config, 'db')` / `'sharedDb'`, not hosted cfg.db/cfg.sharedDb. Gate private/shared schema sections independently. When a private section uses databaseNote, pass **sharedDbOn**, not cfg.sharedDb. Desktop prompt should state: use db_* for private records and shared_db_* for workspace records; creator metadata is advisory; query is read-only; changes require *_execute; file SQL/extensions/views/triggers are unavailable. Do not emit the original shared note's creator-ownership prohibition as an enforced rule. Prefer `desktopSchema` through an authorized tool rather than an unfiltered upstream schema dump. Table cards remain unavailable; do not advertise card_table.

### 4. Panel and shared entry

Root adds `'data'` to `DESKTOP_COWORKER_PANELS` in `apps/ui/lib/desktop/coworker-panel.ts`, preserving original tabs/labels/order. B alone edits `DesktopConversation.tsx` to import/render:

```tsx
<DesktopCoworkerData agent={agent} dialogControl={dialogControl('data')} />
```

Root places workspace-level entry in its existing controls:

```tsx
import { DesktopSharedData } from '@/components/desktop/DesktopSharedData'
<DesktopSharedData />
```

Both wrappers accept optional `DesktopDialogControl`. Current wrappers render their own trigger. Root can use that trigger directly; no nonexistent hideTrigger prop is promised. Neither entry belongs to the other's data scope. No DesktopApp/Board/ControlCenter/Conversation changes were made here.

## Deliberate differences, security and limits

- Private storage stays in the engine's existing per-agent data file. Shared storage stays in its existing workspace data file. Browser agent IDs map through the local roster to immutable engine IDs. No external connectors, public sharing or credential import.
- SQLite itself enforces query_only on a detached transaction connection; the pooled writer is not toggled. SQL is one SELECT/WITH subquery with an outer LIMIT of requested cap+1, max 200. Result text stays under 50k characters, explicitly marking omitted data without claiming to know the full row count. SQL max 20k chars, max 500 params (strings max 50k), writes max 100 statements, XOR single/batch input.
- SQL parser rejects stacked statements, ATTACH/DETACH, PRAGMA (including pragma_* virtual functions), VACUUM, transaction commands, file functions, unlisted extension functions and all internal identifiers, including SQLite's single-quoted table-name syntax. Table/row changes only; RETURNING is unavailable to model SQL because result rows could otherwise be unbounded. The browser's internal, parameterized UPDATE RETURNING returns its actual updated row even when INTEGER PRIMARY KEY changes.
- Schema programs (pre-existing views, triggers or virtual tables) cause desktop data operations to fail closed. They can indirectly reach internal data or execute functions; no attempt is made to run/repair them. This conservative limitation and the built-in function allowlist intentionally narrow general SQLite compatibility. A string literal exactly matching an internal name is also rejected conservatively. Query CPU time and a pathological single cell/expression are not independently resource-budgeted by libsql; row and retained output limits are not a query-complexity guarantee.
- Each tool re-reads its exact grant under the config lock before acting. Writes recheck cancellation/grant before commit. Lifecycle lease prevents deletion while a tool is operating. Row/table/view browser operations commit as a transaction before a success response; failure rolls back. Actual SQLite row/statement counts determine write acknowledgements. Shared creator tracking is best-effort advisory metadata and never an ownership check; metadata recording failure does not misreport a committed data change as failure.
- Authenticated human browser operations allow at most 200 rows/page, eight filters, 200-character terms, offset max 1m, 500 row IDs/delete and 64 columns/update. Internal names are refused before proxy calls. Exports cap at 10k matching rows and 5 MB; overflow returns a truthful error, never a silently partial file. CSV formula-looking strings are escaped as text; filenames are encoded and headers prohibit caching/sniffing. Export limits bound materialized row count and encoded output, not the bytes of one existing cell before decoding.
- Saved views use existing per-database `_rerun_views`; the remembered view key also distinguishes each private coworker from shared scope. Board uses original 50-group limit. Gallery uses the existing authenticated private Files image route; shared scope has no file resolver. No card_table, external database, new connectors, public sharing or credential import.
- New wrappers preserve the original DataBrowser view layouts. Shared copy clarifies that coworker access requires its grant. Table creation/population happens through coworker *_execute; the browser manages existing rows/tables/views.

## Validation status

Authored regressions cover grant separation/revocation, actual private/shared isolation, read-only and quoted hidden-table guards, extension/file SQL, stacked statements, atomic batch rollback, result caps, exact write input bounds, roster routing, explicit browser operations, malformed views and transaction-bound primary-key edits. Root must run them and the policy/auth/UI regressions, including all four views, confirmations/cancellation, saved-view persistence after restart, full exports/overflow, and real Codex create/populate/query replies.

**Tests, type checks, lint, builds, packaging, installs, live model requests and Mac/restart acceptance were not run by this lane.** No installed app control, live database modifications, push or merge. Root owns integration and every execution/acceptance check.
