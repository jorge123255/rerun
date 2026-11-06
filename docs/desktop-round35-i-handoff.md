# Round 35 — Agent I handoff: local single-user workspace lifecycle (W1 local)

Source handoff only. **W1 is not installed/native acceptance.** No tests, typechecks, lint, builds, dependency installs, servers, Docker, provider calls, native/browser UI, microphone, Keychain, restart QA, installed preview, push, merge or publish were run.

- Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round35-local-workspaces`
- Branch: `desktop/round35-local-workspaces`
- Exact prepared parent, verified clean before edits: `5c0f589b51a8129d097f2b97fc420a8acf859b51`
- Original Rerun pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`
- Checklist scope: **W1 local portion only** (no hosted import, remote machines, invitations, roles, billing or network sharing)

## Commits

Commit: branch tip of `desktop/round35-local-workspaces` (parent exactly `5c0f589b51a8129d097f2b97fc420a8acf859b51`). Use `git rev-parse HEAD` for the full SHA.

## File inventory (owned only)

### Contract
- `packages/contracts/src/desktop-workspaces.ts`

### Native main (Electron)
- `apps/desktop/src/main/workspaces/paths.mjs`
- `apps/desktop/src/main/workspaces/catalog.mjs`
- `apps/desktop/src/main/workspaces/receipts.mjs`
- `apps/desktop/src/main/workspaces/coordinator.mjs`
- `apps/desktop/src/main/workspaces/ports.mjs`
- `apps/desktop/src/main/workspaces/isolation.mjs`
- `apps/desktop/src/main/workspaces/copy.mjs`
- `apps/desktop/src/main/workspaces/index.mjs`

### UI server
- `apps/ui/lib/desktop/server/workspaces/schema.ts`
- `apps/ui/lib/desktop/server/workspaces/ports.ts`
- `apps/ui/lib/desktop/server/workspaces/adapters.ts`
- `apps/ui/lib/desktop/server/workspaces/api.ts`
- `apps/ui/lib/desktop/server/workspaces/index.ts`
- `apps/ui/lib/desktop/server/workspaces/catalog.test.ts` (authored, unrun)

### UI client
- `apps/ui/lib/desktop/workspaces/switch.ts`
- `apps/ui/lib/desktop/workspaces/client.ts`
- `apps/ui/lib/desktop/workspaces/copy.ts`
- `apps/ui/lib/desktop/workspaces/index.ts`
- `apps/ui/lib/desktop/workspaces/switch.test.ts` (authored, unrun)

### UI components
- `apps/ui/components/desktop/workspaces/DesktopWorkspaceSwitcher.tsx`
- `apps/ui/components/desktop/workspaces/CreateDesktopWorkspaceDialog.tsx`
- `apps/ui/components/desktop/workspaces/RenameDesktopWorkspaceDialog.tsx`
- `apps/ui/components/desktop/workspaces/DesktopWorkspaceSwitchLoader.tsx`
- `apps/ui/components/desktop/workspaces/index.ts`
- `apps/ui/components/desktop/workspaces/DesktopWorkspaceSwitcher.test.tsx` (authored, unrun)

### Main regressions
- `apps/desktop/test/workspaces-catalog.test.mjs` (authored, unrun)
- `apps/desktop/test/workspaces-coordinator.test.mjs` (authored, unrun)

### Handoff
- `docs/desktop-round35-i-handoff.md` (this file)

No shared supervisor/runtime/IPC/database/index/preload files were modified.

## Original source/design mapping

Pinned sources read with `git show a6d63a4b…`:

| Original source | Local adaptation |
| --- | --- |
| `apps/ui/components/layout/WorkspaceSwitcher.tsx` | `DesktopWorkspaceSwitcher`: pill trigger, sorted workspace list with checkmark on active, **New workspace**, busy disable, begin/abort/enter switch helpers. Omits hosted billing, members/invite, sandbox, expert, admin, paid apps, credit meter, sign-out. |
| `apps/ui/components/dialogs/CreateWorkspaceDialog.tsx` | `CreateDesktopWorkspaceDialog`: **Name** then **Icon** steps, original titles/help ("A workspace groups…", "Choose an illustration…"), Cancel/Back/Continue/Create workspace, spinner Creating. **No Team invite step** (unsupported on local W1). |
| `apps/ui/components/dialogs/WorkspaceSettingsDialog.tsx` + desktop settings | `RenameDesktopWorkspaceDialog` for name rename; existing `DesktopWorkspaceSettings` remains root-owned for icon upload on the active workspace. |
| `apps/ui/lib/workspace/workspace-switch.ts` | `apps/ui/lib/desktop/workspaces/switch.ts`: begin/abort/enter + loader store; enter navigates to `/desktop` (not `/`). |
| `apps/ui/lib/workspace/tab-workspace.ts` | Not ported as multi-tab cloud pins; Mac is single-window. Selection is durable `selected.json` + switch receipts instead of `users.workspace_id` + sessionStorage. |
| `apps/ui/app/api/_actions/workspace.actions.ts` `create/switch/update` | Main catalog `createWorkspace` / coordinator `switchTo` / `renameWorkspace` with requestId idempotency; no Supabase membership. |
| `apps/ui/lib/naming/workspace-name.ts` | Same `WORKSPACE_NAME_MAX` (60) and "Name is required" / under-N-characters copy. |
| `apps/ui/components/layout/WorkspaceSwitchLoader.tsx` | `DesktopWorkspaceSwitchLoader` with reduced-motion-safe fade class. |
| Current Mac `runtime.mjs` `bindWorkspace` / `supervisor.mjs` `workspaceId: 1` | Documented as root authorities W1-A1/W1-A3; coordinator calls typed ports and **fails closed** when unbound. Legacy paths `workspaces/1/engine` and `{dataRoot}/app.db` preserved. |

Responsive source: dialogs use `w-[calc(100vw-2rem)]`, `max-h-[min(100dvh-2rem,…)]`, wrapping footers, 3-col icon grid on narrow / 5-col on `sm+`. Root must verify mobile/tablet/short windows; no viewport check was performed here.

## Dependency inventory (current Mac workspace=1)

| Area | Current assumption | Isolation plan |
| --- | --- | --- |
| Native supervisor | `workspaceId: 1` in runtime.json; health requires `workspaceId === 1` | Port `bindAndStart(id)` + health identity (W1-A1/A3) |
| `bindWorkspace` | Always `workspaces/1/engine` + desktop-owner.json | `engineRootFor(dataRoot, id)`; owner marker per id |
| App database | `{dataRoot}/app.db` with `desktop_workspace CHECK (id = 1)` and pervasive `workspace_id = 1` | Keep workspace 1 DB path; id>1 needs W1-A5 per-workspace DB or lifted CHECK |
| Secrets / Keychain | Install identity + provider custody | Never migrated by this package; default exclusive per workspace |
| Chats / drafts / board | Rows in app.db scoped to workspace 1 | Exclusive; flush drafts before switch |
| Foreman / schedules / MCP / services | Bound to runtime + app.db | Freeze admissions (W1-A2); exclusive state |
| Shared files | `workspaces/1/engine/shared` | Follow active engine root once supervisor binds id |
| Browser sessions | Under engine guest data | Exclusive under workspace engine root |
| IPC / preload | No workspace channels | Root mounts W1-A4 |
| Cold launch | Always starts workspace 1 | `coldLaunchTarget()` read-only; root `launch()` must call bindAndStart (W1-A6) |

## Public contract / exports

File: `packages/contracts/src/desktop-workspaces.ts`

Root must add to `packages/contracts/src/index.ts`:

```ts
export * from './desktop-workspaces.js'
```

Canonical exports include: `DESKTOP_WORKSPACES_CONTRACT_VERSION`, `DESKTOP_WORKSPACE_NAME_MAX`, `DEFAULT_DESKTOP_WORKSPACE_NAME`, `LEGACY_DESKTOP_WORKSPACE_ID`, workspace/selection/receipt/create/rename/switch/list schemas + types, `desktopWorkspaceRefusal*`, `desktopWorkspaceSharedPreferenceKeys` (empty — isolation default), `desktopWorkspaceIsolationDomains`.

## Persistence / recovery semantics

### On-disk layout
```
{dataRoot}/
  app.db                          # legacy workspace 1 only
  identity.encrypted              # install (unchanged)
  workspaces/
    catalog.json                  # durable catalog (atomic 0600)
    selected.json                 # last published selection
    switches/{receiptId}.json     # durable switch receipts
    1/engine/…                    # EXISTING engine root (unchanged)
    1/owner.json                  # written on seed when missing; legacy desktop-owner.json still accepted
    {n}/engine/…                  # exclusive new workspace engine roots
    {n}/owner.json                # installId + workspaceId seal — never adopt foreign/same-name dirs
    {n}/app.db                    # reserved for root W1-A5 (not opened by this package)
```

### Switch phases (durable)
`accepted → admissions_frozen → drafts_flushed → work_drained → old_runtime_closed → target_starting → identity_verified → published`

Failure:
- **Before** `old_runtime_closed`: `failed_before_drain` / unfreeze / selection unchanged (rollback).
- **After** drain: `failed_after_drain` — do not silently reopen the old runtime under a different identity; UI/reconcile surfaces Retry/recovery. `reconcile()` / `coldLaunchTarget()` are **non-effectful** (no start, create, erase, or adopt).

### Create / rename
- Stable numeric ids; directory name === decimal id.
- `requestId` idempotency keys stored on catalog rows (stripped from public list projection).
- Create never auto-switches.

### Cold launch contract
`createWorkspaceCoordinator(…).coldLaunchTarget()` returns the selected workspace id for root's `launch()` to start. It never starts engines. If an after-drain open receipt exists, it reports `busy` for manual recovery.

## Concrete adapters vs missing authorities

| Authority | Meaning | Status |
| --- | --- | --- |
| Catalog create/rename/list/selection/receipts/coordinator ordering | File-backed main package + server handlers | **Implemented (source)** |
| Product UI switcher/create/rename/loader | Components + client switch helpers | **Implemented (source)** |
| Isolation inventory + path helpers | `isolation.mjs` + contract domains | **Implemented (source)** |
| W1-A1 Supervisor `bindAndStart(workspaceId)` / `stopAndDrain` for id≠1 | Patch `runtime.mjs` `bindWorkspace` + `supervisor.mjs` replace literal `1` | **Missing — fail closed** |
| W1-A2 Admission freeze/unfreeze | Block new runs/webhooks/schedules/Foreman during switch | **Missing — fail closed** |
| W1-A3 Health/runtime identity reports active workspaceId | Replace `z.literal(1)` / `workspaceId === 1` checks | **Missing — fail closed** |
| W1-A4 IPC `desktop:workspaces-*` + preload | Wire coordinator in `index.mjs` / `preload.cjs` | **Missing — fail closed** |
| W1-A5 Per-workspace app.db (id>1) or lift CHECK + scope queries | Central DB/migration activation | **Missing** |
| W1-A6 Cold-launch reads `selected.json` before first start | `launch()` fragment below | **Missing** |
| Draft flush during switch | Reuse `BeforeQuitDrafts` protocol against the renderer | **Partial — port shaped; root must bind** |

Server adapters call the main bridge only. `createInProcessWorkspaceBridge` exists for authored regressions / root harnesses — production must use IPC (W1-A4).

## Additive migration + central patch fragments (root only)

### 1) Contracts re-export
`packages/contracts/src/index.ts`: `export * from './desktop-workspaces.js'`

### 2) Schema migration (suggested version 25)
Do **not** edit shared migration runners from this lane. Append:

```ts
import { DESKTOP_LOCAL_WORKSPACES_MIGRATION } from '@/lib/desktop/server/workspaces'
// inside initializeDesktopRound3x steps array:
{ version: DESKTOP_LOCAL_WORKSPACES_MIGRATION.version, id: DESKTOP_LOCAL_WORKSPACES_MIGRATION.id, sql: DESKTOP_LOCAL_WORKSPACES_MIGRATION.sql },
```

SQL seeds workspace 1 from existing `desktop_workspace` without moving files. File catalog remains cold-launch source of truth until root chooses to mirror both ways.

### 3) Main launch + IPC (illustrative fragment — do not apply blindly over newer root edits)

```js
import { createWorkspaceCoordinator, seedLegacyCatalog } from './workspaces/index.mjs'
// after loadIdentity(dataRoot, …):
await seedLegacyCatalog(dataRoot, identity.installId, { name: /* existing workspace name if known */ 'My workspace' })
const workspacePorts = {
  freezeAdmissions: async () => {/* W1-A2 */ false},
  unfreezeAdmissions: async () => {},
  flushDrafts: async () => draftQuit.request(value => window.webContents.send('desktop:before-quit', value)).then(saved => ({ saved })),
  stopAndDrain: () => supervisor.stop(),
  bindAndStart: async (workspaceId) => {/* W1-A1: supervisor.startFor(workspaceId) */ throw Object.assign(new Error('W1-A1'), { code: 'authority_missing', authority: 'W1-A1' }) },
  verifyRuntimeIdentity: async (workspaceId) => supervisor.runtime?.workspaceId === workspaceId,
  isQuitInProgress: () => quitting,
}
const workspaces = createWorkspaceCoordinator({ dataRoot, installId: identity.installId, ports: workspacePorts })
const cold = await workspaces.coldLaunchTarget()
// W1-A6: start cold.workspaceId instead of implicit 1
ipcMain.handle('desktop:workspaces-list', event => { trusted(event); return workspaces.list() })
ipcMain.handle('desktop:workspaces-create', (event, body) => { trusted(event); return workspaces.create(body) })
ipcMain.handle('desktop:workspaces-rename', (event, body) => { trusted(event); return workspaces.rename(body) })
ipcMain.handle('desktop:workspaces-switch', (event, body) => { trusted(event); return workspaces.switchTo(body) })
ipcMain.handle('desktop:workspaces-reconcile', event => { trusted(event); return workspaces.reconcile() })
```

### 4) Preload fragment
```js
workspaces: {
  list: () => ipcRenderer.invoke('desktop:workspaces-list'),
  create: value => ipcRenderer.invoke('desktop:workspaces-create', value),
  rename: value => ipcRenderer.invoke('desktop:workspaces-rename', value),
  switchTo: value => ipcRenderer.invoke('desktop:workspaces-switch', value),
  reconcile: () => ipcRenderer.invoke('desktop:workspaces-reconcile'),
}
```

### 5) UI route mounts (Next route modules export handlers only)
```ts
import { desktopWorkspaceHandlers } from '@/lib/desktop/server/workspaces'
const h = desktopWorkspaceHandlers({ main: /* IPC bridge from desktop runtime context */ null })
// GET  /api/desktop/workspaces           -> h.list / h.reconcile
// POST /api/desktop/workspaces/create    -> h.create
// POST /api/desktop/workspaces/rename    -> h.rename
// POST /api/desktop/workspaces/switch    -> h.switchTo
```

### 6) Mount UI
Render `DesktopWorkspaceSwitcher` with `createDesktopWorkspaceClient()` near `DesktopWorkspaceMenu`, and `DesktopWorkspaceSwitchLoader` at the desktop shell root. Do not replace the existing settings/icon upload flow.

### 7) Supervisor/runtime identity (required for real switches)
- `bindWorkspace(root, identity, workspaceId)` using `workspaces/{id}/engine`
- runtime.json `workspaceId: <id>`
- health check compares to active id (not literal `1`)
- `apps/ui/lib/desktop/server/runtime.ts` replace `z.literal(1)` with positive int once ready

## Supported / dependent / unsupported matrix

| Capability | Status |
| --- | --- |
| Durable local catalog create/rename/list; exclusive dirs; legacy workspace 1 path preservation | Supported (source) |
| Durable switch receipts + ordered coordinator + rollback-before-drain / fail-after-drain | Supported (source); effects need ports |
| Non-effectful reconcile / coldLaunchTarget | Supported (source) |
| Original-style switcher + create (name/icon) + rename dialogs + loader | Supported (source) |
| Isolation inventory + empty shared-preference allowlist | Supported (source) |
| Additive SQL fragment + exact root mount instructions | Supported (source fragments) |
| Actual multi-id engine start, health identity, admission freeze, IPC, per-ws DB, cold-launch wiring | **Dependent on root (W1-A1…A6)** |
| Hosted invites, members, roles, billing, sandbox, remote machines, network sharing | **Unsupported** |
| Automatic live secret migration / Keychain reads | **Unsupported (never)** |

## Authored-but-unrun regressions

1. `apps/desktop/test/workspaces-catalog.test.mjs` — seed legacy; create exclusivity + requestId idempotency; refuse foreign same-name dir; rename idempotency; owner seal.
2. `apps/desktop/test/workspaces-coordinator.test.mjs` — effect order; draft-flush rollback; missing authority fail-closed; switch idempotency; non-effectful reconcile; coldLaunchTarget; serialize/busy.
3. `apps/ui/lib/desktop/server/workspaces/catalog.test.ts` — migration export; create/rename; switch idempotency; missing bridge; draft rollback.
4. `apps/ui/lib/desktop/workspaces/switch.test.ts` — begin/abort in-flight.
5. `apps/ui/components/desktop/workspaces/DesktopWorkspaceSwitcher.test.tsx` — list/New workspace; busy open-receipt copy without calling switch.

Root alone executes `node --test` / vitest / typecheck / packaging / Mac restart QA.

## Known limits

- Until W1-A1/A3/A4/A6 are wired, UI create/rename can work in-process for harnesses, but production switch always fails closed with `authority_missing`.
- Until W1-A5, new workspaces have sealed engine directories but no separate app.db activation — chats/grants for id>1 are not writable through the current single-`CHECK (id=1)` schema.
- Provider credential isolation is defined, not executed (no secret reads/migration).
- `DesktopWorkspaceMenu` is unchanged; root decides composition with `DesktopWorkspaceSwitcher`.
- No dependent agent contract revision was required; this lane owns the canonical workspace identity/transition contract going forward.

## Commit verification

- Branch `desktop/round35-local-workspaces` (see `git rev-parse HEAD`)
- Parent exactly `5c0f589b51a8129d097f2b97fc420a8acf859b51`
- Worktree clean after commit

## Explicit non-claims

- No checks were executed.
- This is **not** Mac acceptance and does **not** mark W1 complete on the shared checklist.
- Nothing was pushed, merged, installed, or activated against the user's live data.
