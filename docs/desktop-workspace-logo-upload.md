# Desktop workspace logo upload (lane handoff)

Adds the original choose/drop-image interaction to the integrated workspace settings dialog
(the B5 illustration picker slice). Source-only lane — the integration owner runs all
validation and Mac testing.

Base: `49a224e75c2d6b76f441b24f41d813d2b382ee99`. Branch: `desktop/workspace-logo-upload`.

## What was ported

- `apps/ui/components/desktop/DesktopWorkspaceSettings.tsx` — the original form's logo draft,
  reduced to the supported kinds: `{ kind: 'current' } | { kind: 'catalog' } | { kind: 'upload' }`
  (`File` + local object URL). The preview is wrapped in the original `FileDropzone`
  (`@rerun/ui/forms`) with the upload badge, `aria-label="Upload a logo"` and
  `accept="image/png,image/jpeg,image/webp"`; the preview shows the draft's object URL, the
  picked illustration, or the workspace's current icon, exactly like the original's
  `logoDraftSrc`. Picking resets the upload and choosing resets the pick, with the draft's
  object URL revoked through the original cleanup effect. Save commits name and selected icon
  together: catalog and name-only saves keep the existing JSON payload, an upload drafts into
  one multipart submission like the original form. Cancel discards the draft — including the
  object URL — without writing. The illustration grid, its 50 entries, the failed-read Retry,
  the quit barrier, the admit-once guard and the stale-response guards are unchanged.
- `apps/ui/lib/desktop/server/workspace-icon.ts` — the desktop icon schema/storage module, which
  owns its migration:
  - `desktop_workspace_icon_bytes` (`identity` UUID, `content_type`, `bytes BLOB`, timestamp):
    bounded, locally stored rasters with opaque, immutable identities — never a file path or a
    remote URL.
  - `desktop_workspace_icon` widens to an either/or selection (`catalog_id` nullable +
    `upload_id` → the byte identity, one CHECK constraint). Databases from the illustration-only
    slice are rebuilt in one transaction, preserving the committed catalog selection and clearing
    any orphaned bytes; fresh and already-migrated databases skip the rebuild. No central
    `database.ts`/`store.ts` edit is needed.
  - `readDesktopWorkspaceIconSelection` returns the saved-icon descriptor
    `{ iconCatalogId, iconUploadId }`; `readDesktopWorkspaceIcon` keeps the illustration slice's
    catalog-only contract for its existing callers.
  - `writeDesktopWorkspaceIcon` (JSON) now clears a replaced upload's bytes; the new
    `writeDesktopWorkspaceLogoUpload` validates one static PNG/JPEG/WebP against
    `image-bytes.ts`'s structural limits plus the original 8 MB logo limit
    (`Image is too large (max 8MB).`), normalizes it to one ≤256px WebP raster with the existing
    `sharp` pipeline from `lib/images/upload.ts` (`rotate` → `resize 256 inside` →
    `webp q82/effort 6`). Structural validation and image decoding finish before taking the
    database write lock; invalid/undecodable images return 415, and byte/dimension limits return
    413. Bytes + selection + name then commit in one SQLite transaction.
    Replaced selections delete their bytes inside that transaction, so a failed save can neither
    leak staged bytes nor erase the previous icon.
  - `readDesktopWorkspaceIconBytes` serves the committed raster for its identity and fails
    closed on unknown identities.
- `apps/ui/app/api/desktop/workspace/icon/route.ts` — `GET` returns the saved-icon descriptor
  (`{ catalogId }` as before, plus `uploadId` only when an upload is the current icon);
  `PUT` accepts the illustration slice's strict JSON payload and the upload's multipart payload,
  both through `desktopRoute`'s session, host and same-origin checks. Multipart accepts exactly
  one string `name` and one file `logoFile`, with duplicate/unknown fields rejected. The actual
  request stream is counted before parsing: JSON is capped at 4 KiB, and multipart at 8 MiB plus
  64 KiB for its envelope; the file itself still has the 8 MiB limit. Oversized streams are
  cancelled even when Content-Length is missing or understated.
- `apps/ui/app/api/desktop/workspace/icon/bytes/route.ts` — new isolated authenticated read: one
  committed raster by identity with the Files-image serving headers (`nosniff`, sandbox CSP,
  `same-origin` resource policy). Unlike the original public bucket, these authenticated local
  bytes use `private, no-store`, and reads join the current workspace selection so orphaned or
  replaced identities are unavailable.
- `apps/ui/lib/desktop/icon-catalog.ts` — the backward-compatible saved-icon contract:
  `DesktopWorkspaceSavedIcon = { iconCatalogId: string | null; iconUploadId?: string | null }`
  and `desktopWorkspaceIconSelectionUrl(icon)`, which resolves the bundled illustration URL or
  the authenticated bytes route. `desktopWorkspaceIconUrl(catalogId)` is unchanged, and
  `DESKTOP_WORKSPACE_LOGO_ACCEPT` carries the picker's accepted kinds.
- `apps/ui/components/desktop/DesktopWorkspaceSettings.test.tsx` and
  `apps/ui/app/api/desktop/workspace/icon/route.test.ts` — authored regressions (not executed in
  this lane): the extended fixture and route cases cover the upload draft lifecycle, object-URL
  revocation, replacement and reset byte cleanup, rejection preservation, the migration, the
  bytes route's identity checks, and restart persistence. Existing illustration and
  name/catalog cases are unchanged and still assert the same JSON payloads.

Upstream reviewed at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/dialogs/WorkspaceSettingsDialog.tsx` (logo draft, dropzone preview,
  selection treatment, Save/Cancel behavior)
- `apps/ui/components/ui/file-dropzone.tsx` (re-exported wrapper)
- `apps/ui/app/api/_actions/workspace.actions.ts` (`readLogo` validation order, size limit and
  wording, `rehostLogo` normalization, `Unknown icon`, and that a save without a logo field
  never replaces the stored icon)
- `apps/ui/lib/images/upload.ts` (the sharp raster pipeline and immutable object identity)
- `apps/ui/lib/workspace/logo-input.ts` (`LOGO_ACCEPT`, `LOGO_MAX_BYTES`, `LOGO_TOO_LARGE` —
  the SVG/hosted kinds are out of this slice's scope)

## Integration contract (root-owned wiring)

Root owns `DesktopApp`, `DesktopWorkspaceMenu`, the central bootstrap/store and live
integration; this lane changed none of them. The exact wiring to adopt the upload:

1. **Bootstrap.** In `apps/ui/lib/desktop/server/store.ts`, switch the icon read to the
   descriptor and carry both fields:

   ```ts
   import { readDesktopWorkspaceIconSelection } from './workspace-icon'
   const [profile, workspace, agents, appearance, recentCoworkers, savedIcon] = await Promise.all([...,
       openDesktopDatabase(runtime.dataRoot).then(db => readDesktopWorkspaceIconSelection(db))])
   // in the returned bootstrap object:
   iconCatalogId: savedIcon.iconCatalogId,
   iconUploadId: savedIcon.iconUploadId,
   ```

   The read runs the migration itself, so existing installs pick the widened tables up on first
   use without a central schema edit. `readDesktopWorkspaceIcon` still exists with its
   catalog-only contract if any other caller stays on it.

2. **Workspace menu pill.** In `DesktopWorkspaceMenu`, resolve the address from the saved-icon
   descriptor instead of the catalog ID alone, keeping the current default as the fallback:

   ```tsx
   import { desktopWorkspaceIconSelectionUrl } from '@/lib/desktop/icon-catalog'
   <WorkspacePill name={workspaceName}
       iconUrl={desktopWorkspaceIconSelectionUrl({ iconCatalogId, iconUploadId }) ?? '/pricing/solo.png'}
       aria-label={`Workspace menu, ${workspaceName}`} ... />
   ```

   An upload resolves to `/api/desktop/workspace/icon/bytes?identity=…`, which the pill's
   `<img>` loads with the same authenticated session cookie; the URL helper never produces a
   path or a remote address for a stored identity.

3. **DesktopApp state.** `DesktopWorkspaceSettings`' `onSaved` descriptor gains the optional
   `iconUploadId`; the existing handler keeps working unchanged. To render uploads, hold both
   fields and pass them to the menu:

   ```tsx
   onSaved={saved => { setWorkspaceName(saved.name); setSavedIcon({ iconCatalogId: saved.iconCatalogId, iconUploadId: saved.iconUploadId ?? null }) }}
   ```

   `onSaved` fires only after the atomic save succeeds. A failed name, selection or byte cleanup
   rolls the transaction back and does not report a partially saved name. Mounted surfaces can
   refresh across the board, chat and settings without remounting; restart restoration remains
   part of root's integration acceptance.

## Migration and lifecycle choices

- Bytes live in the local `app.db` rather than the filesystem: a ≤256px WebP is small, its
  lifetime is exactly the selection that references it, and one transaction can commit bytes,
  selection and name together — cancel can never stage anything, and a failed save rolls the
  raster back.
- Identity is a random UUID and its content is immutable while selected. Upload replacement,
  switching to an illustration and reset delete the previous bytes inside the committing
  transaction; the illustration-only migration clears any orphaned bytes. The bytes route
  serves only the currently selected identity and does not retain a public browser cache.
- The widened row's CHECK constraint keeps exactly one selection kind, so a corrupt or foreign
  value fails closed on read instead of rendering an untracked address.

## Remaining limits

- Nothing was executed in this lane: tests, type checks, lint, builds and Mac QA belong to the
  integration owner. The authored cases live in the two test files.
- Website-logo lookup, remote links, SVG rasterization, GIF/animation, accounts, workspace
  switching and hosted storage stay out of scope and have no controls; the picker only accepts
  static PNG/JPEG/WebP.
- `sharp` runs inside the staged UI runtime; the desktop packaging already bundles it for the
  engine, and the standalone UI trace must include it like any other native dependency. That
  staging belongs to the integration owner's packaging path.
- The bytes route's `<img>` read relies on the desktop session cookie, like every other
  desktop GET; a client that strips credentials gets the same 401/403 the other routes return.
- The integration fixture (`DesktopWorkspaceSettings.integration.test.tsx`) still stubs the
  JSON contract only; exercising the upload through the real `DesktopApp` mount is left to the
  integration owner's Mac QA of choose/drop, Cancel, Save, replacement, failure preservation
  and restart.
