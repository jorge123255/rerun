# Desktop workspace illustration picker (lane handoff)

Port of the original workspace illustration picker (B5): the built-in illustration slice only.
Source-only lane — the integration owner runs all validation and Mac testing.

Base: `18b7e32fee452237ce1e7d5b79ea7cd5d0b18429`. Branch: `desktop/workspace-icons`.

## What was ported

- `apps/ui/components/desktop/DesktopWorkspaceSettings.tsx` — the original
  `WorkspaceSettingsDialog` layout reduced to the built-in picker slice: the same header copy,
  preview beside the name field, `Or pick an illustration` grid (5/10 columns, ten visible,
  `Show all 50`/`Show less`), the original selection treatment (ring + check badge,
  `aria-pressed`), the `e.g. Acme Inc.` name behavior with `WORKSPACE_NAME_MAX`, and the
  original `Cancel`/`Save` footer with the `Saving` spinner. Save always persists the name and
  only persists an icon when one was picked, so name edits stay independent of icon selection;
  Cancel closes without writing anything. Uploads, website-logo links, workspace switching and
  account/member features are omitted, so no control leads to an unsupported action.
- `apps/ui/lib/desktop/icon-catalog.ts` — the desktop icon contract: the original catalog's 50
  entries (verbatim file, description, color and form) with bundled local URLs under
  `/workspace-icons/`, plus `desktopWorkspaceIconById` and `desktopWorkspaceIconUrl`. The
  persisted token is the illustration's own file name validated by lookup — never an arbitrary
  URL or path. The hosted `lib/blobs/catalog.ts` stays untouched and is not imported here.
- `apps/ui/lib/desktop/server/workspace-icon.ts` — the authenticated store module. It owns the
  initializer (`CREATE TABLE IF NOT EXISTS desktop_workspace_icon`, keyed by workspace_id with a
  `catalog_id`, run lazily on the pooled client, retried after a failure) so the central
  `database.ts`/`store.ts` stay untouched, plus a validated read and write (`Unknown icon` for
  any ID outside the allowlist).
- `apps/ui/app/api/desktop/workspace/icon/route.ts` — `GET` returns
  `{ catalogId: string | null }`; `PUT` accepts `{ catalogId }`, validates it against the
  catalog and upserts. Both go through the existing `desktopRoute` (session cookie and
  same-origin), matching the other desktop routes.
- `apps/ui/public/workspace-icons/` — the 50 original WebP illustrations, downloaded from the
  project's public `blob-illustrations` bucket and verified against the catalog set;
  `ATTRIBUTION.md` records the source, date and AGPL-3.0 license. All 50 were available, so no
  choice was omitted.
- `apps/ui/components/desktop/DesktopWorkspaceSettings.test.tsx` — authored regression cases
  (not executed in this lane): original layout and copy, preview/selection/expand behavior,
  save-without-pick leaving the icon untouched, pick-then-save through the validated catalog ID,
  rejected-catalog and failed-name errors, the unavailable icon read, and Cancel not mutating
  the saved icon.

Upstream reviewed at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/dialogs/WorkspaceSettingsDialog.tsx` (form, grid, naming behavior)
- `apps/ui/lib/blobs/catalog.ts` (entry data and `getBlobByFile` validation)
- `apps/ui/app/api/_actions/workspace.actions.ts` (name validation, `iconFile` → validated
  catalog lookup, `Unknown icon` wording, and that a save without a logo field never replaces
  the stored icon)
- `apps/ui/components/layout/WorkspaceSwitcher.tsx` (icon presentation in the switcher and menu)
- `apps/ui/lib/naming/workspace-name.ts` (`WORKSPACE_NAME_MAX`)

## Integration contract (root-owned wiring)

Root owns `DesktopApp`, `DesktopBoard`, `DesktopWorkspaceMenu` and the bootstrap/schema wiring;
this lane changed none of them. The exact wiring:

1. **Persisted icon for the pill and mounted surfaces.** Extend the desktop bootstrap with the
   icon so it survives restart, using this lane's store read inside the existing bootstrap
   query set:

   ```ts
   // apps/ui/lib/desktop/server/store.ts (root-owned)
   import { readDesktopWorkspaceIcon } from './workspace-icon'
   // alongside the existing parallel reads:
   const [profile, workspace, agents, appearance, iconCatalogId] = await Promise.all([...,
       openDesktopDatabase(runtime.dataRoot).then(db => readDesktopWorkspaceIcon(db))])
   // in the returned bootstrap object:
   workspace: { id: 1, name: String(workspace.rows[0].name) },
   iconCatalogId,
   ```

   `readDesktopWorkspaceIcon` runs the table initializer itself, so no central schema edit is
   needed and existing databases pick the table up on first use.

2. **Workspace menu pill.** In `DesktopWorkspaceMenu` (root-owned), pass the bundled URL for
   the persisted catalog ID, keeping the current default as the fallback:

   ```tsx
   <WorkspacePill name={workspaceName} iconUrl={desktopWorkspaceIconUrl(iconCatalogId) ?? '/pricing/solo.png'}
       aria-label={`Workspace menu, ${workspaceName}`} ... />
   ```

   `desktopWorkspaceIconUrl` resolves only catalog members, so a stored ID can never produce an
   arbitrary path. `WorkspacePill`'s `fallbackIconUrl` stays available if the integration wants
   a second fallback.

3. **Mount the dialog.** Root decides where the entry point lives (the original reached it from
   the switcher's Settings item). The component is self-contained:

   ```tsx
   <DesktopWorkspaceSettings
       open={workspaceSettingsOpen}
       onOpenChange={setWorkspaceSettingsOpen}
       workspaceName={workspaceName}
       onSaved={saved => { setWorkspaceName(saved.name); setIconCatalogId(saved.iconCatalogId ?? null) }}
   />
   ```

   `onSaved` is the refresh across mounted surfaces: the name state feeds the settings header
   and the icon state feeds the pill, both of which already render from `DesktopApp` state. It
   fires after the writes resolve and again reports the name even when only the icon write
   failed. `iconCatalogId` is `null` when the workspace has no icon and omitted when the dialog
   could not read the saved icon, so mounted surfaces keep what they already show.

4. **Restart.** The icon persists in the local `app.db` (`desktop_workspace_icon`) and is
   restored by the bootstrap read above; nothing else is required.

## Remaining limits

- Nothing was executed in this lane: tests, type checks, lint and builds belong to the
  integration owner. The authored cases live in `DesktopWorkspaceSettings.test.tsx`.
- The slice covers the built-in illustrations only. Arbitrary uploads, website-logo lookup,
  remote logo links and rehosting are deferred upstream features and have no controls here.
- The desktop workspace has no seeded icon; until one is picked the pill keeps its current
  default and the dialog's preview renders the muted empty block, like the original form's
  empty `icon_url` case.
- The name write uses the existing `action: 'workspace'` settings change and the icon write
  uses this lane's route; the two writes are separate requests, so a failed icon write can
  leave a saved rename behind. That state is reported through `onSaved` and surfaced in the
  dialog for retry, unlike the original's single all-or-nothing request.
- The 50 bundled illustrations ship only to the desktop build's public directory (the staged UI
  copies all of `apps/ui/public`); the web app keeps using its hosted URLs and does not
  reference this directory.
