# UP-06 / TL05 — `table_view_save` / `table_view_delete`

Source package only. **No Mac acceptance or validation claim.** No tests, typecheck, lint, build, install, fixtures, formatter execution, provider/network activation, UI/browser/native action, live DB operation, Keychain, listener, account/permission prompt, restart, guest/Docker or microphone action was run. No push, PR, rebase, cherry-pick, deploy, release or publication occurred.

## Coordinates and exact consumed SHAs

- **Worktree:** `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/finish-table-views-up06`
- **Branch:** `desktop/finish-table-views-up06`
- **Frozen base verified clean before editing:** `8297fe6404caa114dcb0c2cd6006291a8abb2038` (`desktop/finish-cloud-base-20261106-8297fe64`)
- **Implementation commit:** `8a097e3dbf01f6b48a19b6a43287632b696d07cb`
- **Original reference read-only:** `2a57fa6dd53311f763bfc9abde85997b7f7e5309`
- **Upstream supplement read-only:** `ab3def9bfcf545cc9548f99c63c2b011ca094023`
- **Ongoing cloud integration not consumed or modified:** `bc-714cd9be-c9ad-5527-b2ed-6e79b2a13a08`
- **Codex root and `round38-master-completion`:** read-only references; no edits
- **Commit-hook stop:** none. The implementation commit completed without `--no-verify`; no prohibited hook execution was observed.

## Original mapping

Read at original pin `2a57fa6dd53311f763bfc9abde85997b7f7e5309`:

| Original | This package |
|---|---|
| `apps/engine/src/tools/builtin/cards.ts` `table_view_save` | `desktop/table-view-tools/tools.ts` keeps the named view, scope/table target, layout/columns/fields/formats/tones/groupBy/display/sort/where vocabulary, same-name replacement and original acknowledgement text. |
| `apps/engine/src/tools/builtin/cards.ts` `table_view_delete` | Same exact-name view deletion and missing-view outcome. **Rows and sibling views are untouched.** |
| `apps/engine/src/db/tableViews.ts` `_rerun_views` | `store.ts` calls the existing `saveView`, `deleteView`, `listViews` directly. No substitute schema, second view store or migration. |
| `packages/contracts/src/table-view.ts` | Existing `TableView`, `TableViewInput`, layout/filter/format validation consumed unchanged. No new contract or barrel is introduced. |
| Human `DataBrowser` / `ViewSettingsDialog` | Left intact. Model tools are additive and do not replace or mount over the accepted human editor. |

The base and upstream `tableViews.ts` are identical in the inspected implementation. `card_table` remains display-only and is not treated as a write path.

## Changed paths

- `apps/engine/src/desktop/table-view-tools/index.ts`
- `apps/engine/src/desktop/table-view-tools/tools.ts`
- `apps/engine/src/desktop/table-view-tools/store.ts`
- `apps/engine/src/desktop/table-view-tools/tools.test.ts`
- `apps/engine/src/desktop/table-view-tools/store.test.ts`
- `docs/desktop-finish-table-views-up06-handoff.md`

No central registry, grant enum, contract barrel, migration, DesktopApp, DesktopConversation, composer, packaging identity or other worktree file was edited.

## Behavior and authority

1. **Real production stores:** default adapters resolve `getAgentDb(ctx.agent.id)` for `scope:'agent'` and `getSharedDb()` for `scope:'shared'`, with the existing hidden-table lists. Tests inject operation adapters only at the tool boundary; production does not use an in-memory substitute.
2. **Two permissions required:** root adds a new default-off `tableViewWrite` grant. The current agent must be enabled, pass that grant and still hold the matching existing `db` or `sharedDb` grant. Config is re-read at execution and after commit. No permission is inherited by duplication or inferred from a table's creator metadata.
3. **Validation:** original table-view schema and `checkViewColumns` enforce actual columns, formats, filters, sort, title and board grouping. Internal `sqlite_` / `_rerun_` table identities and programmable desktop schemas are refused through `assertPlainDataSchema`.
4. **Concurrent-edit honesty:** the initial exact view is captured before a write transaction. The transaction revalidates that it is unchanged before saving/deleting. A human edit, creation or deletion during admission produces `DesktopTableViewConflictError` rather than silently overwriting a newer version. Same-name replacement retains the original view ID and position.
5. **Stop and uncertain acknowledgement:** cancellation is checked before commit and after commit. No authority wait occurs inside the write transaction. If post-commit Stop or authorization loss prevents acknowledgement, `DesktopTableViewCommitUnknownError` explicitly says to inspect before retrying. It is not reported as success and no effect is automatically retried. A committed effect is not rolled back or hidden.
6. **View-only deletion:** the only delete call is canonical `deleteView` against `_rerun_views`. There is no row/table drop path.
7. **Identity/lifecycle:** queued admission uses the coworker lock and timeout; admitted work holds `beginDesktopAgentWork` until settlement. Owner/session/draft/board/default/Markdown/skill state is not read or changed.

## Exact root activation fragments

Root/cloud integration owns these central files. No fragment below was applied here.

### 1. Grant ID and Tools row

In `packages/contracts/src/desktop-tool-grants.ts`, add `tableViewWrite` to `desktopRerunGrantIds` (adjacent to `cardTable`):

```ts
'cardTable', 'tableViewWrite',
```

Add to `desktopRerunToolCatalog` after the `cardTable` entry:

```ts
supported(
  'tableViewWrite',
  'Edit saved database views',
  'Create, replace and delete saved database views without changing table rows. Requires the matching private or shared database permission.',
  'table_view_save',
  'table_view_delete',
),
```

The existing `hasDesktopToolGrant` default branch already requires the ID to be exactly true. No migration or new contract barrel is needed.

### 2. Desktop registry mount

In `apps/engine/src/tools/registry.ts`:

```ts
import { desktopTableViewTools } from '../desktop/table-view-tools/index.js'
```

Add immediately after the existing `desktopTableCardTools(...)` spread in the desktop composition:

```ts
...desktopTableViewTools(ctx, config => config.enabled && hasDesktopToolGrant(config, 'tableViewWrite')),
```

Keep the existing `desktopTableCardTools` mount and all later MCP conflict checks. If tool registration must remain wholly unavailable before the grant enum lands, land the enum/catalog fragment in the same integration commit.

### 3. Prompt instruction

Where root composes the desktop tool instructions, import:

```ts
import { DESKTOP_TABLE_VIEW_INSTRUCTION } from '../desktop/table-view-tools/index.js'
```

Append `DESKTOP_TABLE_VIEW_INSTRUCTION` only when `tableViewWrite` is enabled. The generic catalog will already include the two tool names; this additional text preserves the view-only, concurrent-edit and uncertain-acknowledgement rules. Do not instruct the model to delete rows or replace the human editor.

## Authored but unrun regressions

| Source | Expected coverage when root executes it |
|---|---|
| `store.test.ts` | Real canonical `_rerun_views` writes on SQLite; board save and row preservation; unknown-column/incomplete-layout refusal; same-identity replacement; concurrent human-edit conflict; exact view deletion with sibling/row preservation; missing-view no-op; post-commit unknown; internal-table refusal. |
| `tools.test.ts` | No registration without the explicit grant; current config and matching scope enforcement; original save/delete text; exact agent/shared identity; missing-view message without a row deletion path. |

No regression was executed, and no red/green claim is made. Root additionally needs to cover stopped admission, abort before commit, abort after commit, shared-store isolation, duplicate-name races against the human editor, and production `getAgentDb`/`getSharedDb` bindings.

## Already implemented / new / gated

| Area | Status |
|---|---|
| Human view editor and canonical `tableViews` store | **Already on frozen base; preserved** |
| `card_table` read/display behavior | **Already on frozen base; not used as a write path** |
| Original save/delete schemas, result text and real store adapters | **New source package** |
| View-write grant, current scope checks and concurrent-edit fencing | **New source package; default-off until root mounts** |
| Stop/uncertain outcome semantics | **New source package; unexecuted** |
| Grant enum/catalog and central tool registry mount | **Gated on root/cloud integration fragments above** |
| Tests/typechecks/builds/live DB/native/restart acceptance | **Gated on root; nothing executed here** |
| Row deletion, table deletion, second database, migration or human-editor replacement | **Unsupported/out of scope** |
| Duplicate grant/credential inheritance policy | **Unchanged root/user decision** |
| Portable capture/file operations | **Not in this package; no portable paths touched** |

## Risks and limitations

- Direct production-store adapters use the same canonical authority as the human data routes; they do not add a `data-worker` protocol. Stop fences admission and commit acknowledgement, but interruption timing inside native SQLite remains for root execution checks. Do not infer mid-query cancellation from this source alone.
- A conflict is intentionally returned instead of overwriting a concurrent edit. Root should verify the exact transaction behavior against the human editor on both store types.
- `DesktopTableViewCommitUnknownError` deliberately avoids claiming whether the user-visible write should be retried. The current view must be inspected first.
- No thin UI acknowledgement component was added: the original tool result string is the existing chat acknowledgement. No new UI design was required.
- Source delivery is not integration or Mac acceptance. Root owns central mounting, all execution checks, repairs and any installed/restart decision.
