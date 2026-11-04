# Desktop workspace illustration picker

This ports Rerun's built-in workspace illustration picker and its name/icon save behavior to the
Mac app. The integration owner runs all checks, packaging and native acceptance; this document
describes the source contract rather than claiming a release has passed.

## Original design and assets

Original reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

- `components/dialogs/WorkspaceSettingsDialog.tsx`: header copy, preview beside the name field,
  “Or pick an illustration” grid, five/ten columns, ten initial choices, Show all 50/Show less,
  selected ring/check badge, Cancel/Save footer and saving spinner.
- `lib/blobs/catalog.ts`: the 50 catalog entries and exact filename lookup.
- `app/api/_actions/workspace.actions.ts`: name validation, catalog validation and preserving the
  current icon when the save omits an icon selection.
- `components/layout/WorkspaceSwitcher.tsx`: workspace icon presentation.
- `lib/naming/workspace-name.ts`: shared `WORKSPACE_NAME_MAX` (60 characters).

`lib/desktop/icon-catalog.ts` retains the original entries, descriptions, colors and forms while
resolving their URLs to bundled `/workspace-icons/` files. `public/workspace-icons/` contains all
50 original WebP illustrations. Its `ATTRIBUTION.md` records their public source and license.
An icon ID is a catalog filename; neither the client nor server converts arbitrary input into a
URL or filesystem path. Uploads, website-logo fetching, accounts and workspace switching remain
outside this slice.

## Atomic local save

`lib/desktop/server/workspace-icon.ts` owns the `desktop_workspace_icon` table, keyed by a foreign
key to the existing local workspace. Its initializer runs lazily on the pooled client, caches a
`Promise<void>`, and removes a failed initialization from that cache so a later request can retry.
No central schema migration is required for this table.

The authenticated `/api/desktop/workspace/icon` route exposes:

- `GET` → `{catalogId: string | null}` with `Cache-Control: no-store`.
- `PUT {name: string, catalogId?: string | null}` → `{name, catalogId}` after the transaction commits.

The name is trimmed and must contain 1–60 characters. A non-null icon ID must match the exact
allowlist. Unknown fields or invalid input return 400 using the existing `{error: string}`
response shape. Validation happens before changing the workspace name or icon.

PUT updates the name and optional icon in **one SQLite write transaction**. Omitting `catalogId`
leaves the current icon row untouched. Explicit `null` removes the selection and restores the
default illustration; this reset is supported by the API without requiring a reset control in
the picker. An icon insert, update or reset failure rolls the name back too. There is no preceding
PATCH to `/api/desktop/settings`, no partial-success callback, and no second save for the icon.
The response is read from the saved rows and returned only after commit.

Reads validate persisted IDs against the catalog. A corrupt or obsolete stored value returns
`null` rather than an arbitrary URL. Name-only saves preserve the underlying selection, while a
new valid pick can repair it. A missing workspace returns 404 instead of creating an orphan icon.
The route uses the standard desktop session-cookie/host checks and same-origin mutation check.

## Mounted UI contract

`DesktopWorkspaceSettings` follows the original dialog design. Cancel writes nothing. Save sends
one atomic PUT and publishes the returned committed name and catalog ID through `onSaved`.
A failed save leaves the user's draft available to retry and does not report a partial rename.
A failed icon read is explicit and retryable; name-only save can preserve the persisted icon
without guessing its value from a failed GET.

Root-owned App/bootstrap/menu wiring supplies the persisted icon to mounted workspace surfaces:

```tsx
<WorkspacePill
    name={workspaceName}
    iconUrl={desktopWorkspaceIconUrl(iconCatalogId) ?? '/pricing/solo.png'}
/>
```

Bootstrap uses `readDesktopWorkspaceIcon(db)` so the saved selection survives restart. The
validated catalog URL helper is also the fallback boundary for mounted surfaces. The settings
entry point uses existing app navigation/dialog/quit guards; opening it does not replace the
board or discard coworker drafts.

## Authored coverage

The API regressions cover authenticated reads and same-origin saves, default selection, trimmed
names, valid-name limits, unknown/path/URL IDs, strict input fields, name-only preservation,
explicit reset, restart persistence, corrupt stored values, missing workspace and the foreign
key. SQLite failure triggers exercise rollback for icon insert, update and reset, followed by
successful retry. A failed lazy initializer is verified to remain retryable.

Component regressions cover the original layout, selection/expand behavior, one atomic request,
returned committed state, load/save errors and Cancel. All execution and native verification
remain root-owned.
