# UI02 — coworker Files grid

The tip is the docs commit that adds this file. This file does not name that commit.

Register ID: UI02 / D5. Source delivery only. Not Mac acceptance. No PASS.

## SHAs

- Base: `8297fe6404caa114dcb0c2cd6006291a8abb2038` (`desktop/next-files-grid-ui02`, frozen pub `desktop/finish-cloud-base-20261106-8297fe64`)
- Implementation: `2aa9ee2a16de58a0c59d2a94d4bad51569f2f81d` — `feat(desktop): show coworker files as a grid with type icons and thumbnails`
- Original pin (read only): `2a57fa6dd53311f763bfc9abde85997b7f7e5309` in `upstream-review-20261106`
- Supplement `ab3def9bfcf545cc9548f99c63c2b011ca094023` was not required. The original pin already has the grid.

## What changed

Additive and unmounted. `DesktopCoworkerFiles` still renders the common-icon list (`FolderIcon` for a folder, `FileTextIcon` for every file). Root applies the fragment below. UI01, FX skeletons, Memories, Settings, Schedules, Tools, DesktopApp, DesktopConversation, composer, contract barrels, grant enums, migrations, and packaging were not edited.

Paths in the implementation commit:

- `apps/ui/components/desktop/files-grid/DesktopFilesGrid.tsx`
- `apps/ui/components/desktop/files-grid/model.ts`
- `apps/ui/components/desktop/files-grid/index.ts`
- `apps/ui/components/desktop/files-grid/DesktopFilesGrid.test.tsx` (authored, not run)
- `apps/ui/components/desktop/files-grid/model.test.ts` (authored, not run)

## Original citations

From `2a57fa6dd53311f763bfc9abde85997b7f7e5309`:

- `apps/ui/components/files/FileGrid.tsx` — `grid content-start gap-1 p-3 [grid-template-columns:repeat(auto-fill,minmax(84px,1fr))]`, parent `..` tile, directory-first sort
- `apps/ui/components/files/FileTile.tsx` — tile chrome, two-line name, file title `name — bytes`
- `apps/ui/components/files/FileThumbnail.tsx` — folder glyph, image under the byte cap, text head on the sheet, otherwise extension badge or type icon
- `apps/ui/components/files/FileGlyph.tsx` — `FolderGlyph`, `FileSheetGlyph`, image frame
- `apps/ui/components/files/sort-file-entries.ts` — directories first, then `localeCompare`
- `apps/ui/components/files/useFileThumbnails.ts` — in-view text heads, four at a time, dropped when the reset key changes; a failed read stores `''`
- `apps/ui/lib/files/preview.ts` — `fileTypeIcon`, `THUMB_IMAGE_MAX_BYTES` (3_000_000), `THUMB_TEXT_MAX_BYTES` (262_144)
- `apps/ui/app/api/_actions/file.actions.ts` — `readFileHeadAction` keeps `content.slice(0, 600)`
- `apps/ui/components/agent/AgentPanelFiles.tsx` — grid only on the non-loading, non-empty content branch

Not copied from that grid: publish, unshare, download, and its own delete confirm. The desktop panel already owns rename, delete, and refusal. `SkeletonFileGrid` was not copied.

## Behavior

`DesktopFilesGrid` replaces the list markup only.

- Folders use `FolderGlyph`. Files use the original sheet. Audio, video, archive, binary, and code files get `fileTypeIcon`. Plain text and PDF keep the extension badge until a text head exists. PDF is not a text thumb.
- A small image (`filePreviewKind === 'image'`, size from 1 through 3_000_000) sets `<img>` to the same-origin `GET {filesBase}/image?path&identity` route. `filesBase` must be `/api/desktop/agents/:id/files` with no query or hash. Any other base yields no image URL. There is no other host.
- If that image errors, the tile drops the image and shows the sheet once for that URL in that folder. It does not retry. Changing folder clears the failure set. That is not a successful preview.
- A text file from 1 byte through 256 KiB asks `onRequestText(path)` once when the tile intersects (root margin 200px). The caller reads `GET {base}/read`. `desktopFilesTextHead` keeps the first 600 characters. A non-OK body, `error`, `conflict`, or non-string `content` becomes `''`. An empty head stays a glyph. It does not open the preview and it does not show the preview alert.
- Reserved names are omitted: case-insensitive `internal.rerun*` and `.rerun-skill*`. Ordinary hidden names such as `.env` stay when the listing includes them. `.rerun-edit-` and the other coworker recovery prefixes still list. Preview, rename, and delete of those names still refuse on the existing routes. This package does not add a second refusal authority for them.
- Click a folder: `onOpenDir(name)`. Click a file: `onOpenFile(name)`. The panel’s `openListed` still chooses image, audio, video, PDF, or text preview. Parent `..` calls `onGoUp` and clears the menu without opening an entry.
- Context menu, `RenameField` (stem selection, Enter, Escape), delete confirm, pending lock, import, breadcrumbs, and the preview/editor branches stay in `DesktopCoworkerFiles`. The grid only reports `onContextMenu(name)` and renders `renderRename`.
- `pending` disables the tiles. A disabled tile does not call open.
- Empty visible entries keep the sentence `This is your coworker’s workspace. Files it downloads, creates or edits during its runs are stored here.` The parent tile still shows when `onGoUp` is set.
- Loading (`Loading files…`) and the folder error alert stay outside the grid.
- Sort is directories first, then `localeCompare`. The current list follows API order.
- Desktop entries are `file` or `dir`. There is no symlink tile.

## Root fragment

Insert these imports in `apps/ui/components/desktop/DesktopCoworkerFiles.tsx`:

```tsx
import { DesktopFilesGrid, desktopFilesTextHead } from '@/components/desktop/files-grid'
import { useFileThumbnails } from '@/components/files/useFileThumbnails'
```

Insert these hooks in `FilesPanel` after the preview `useEffect` that fetches `${base}/read`, and before every `return`:

```tsx
const textHeadKey = `${agent.id}\0${currentPath}\0${entries.map(entry => `${entry.type}:${entry.name}:${entry.size}:${entry.identity ?? ''}`).join('\0')}`
const readTextHead = useCallback(async (path: string) => {
    try {
        const response = await fetch(`${base}/read?path=${encodeURIComponent(path)}`, { cache: 'no-store' })
        const body: unknown = await response.json().catch(() => null)
        return desktopFilesTextHead(body, response.ok)
    } catch {
        return ''
    }
}, [base])
const { heads, request } = useFileThumbnails({ read: readTextHead, resetKey: textHeadKey })
```

Replace only the `<ul className="space-y-0.5">…</ul>` inside the existing `ContextMenuTrigger`. Keep the loading paragraph, the error paragraph, `ContextMenu`, `ContextMenuContent` (Rename / Delete), and `ConfirmDialog`.

```tsx
<DesktopFilesGrid
    entries={entries}
    currentPath={currentPath}
    filesBase={base}
    selectedName={selectedHere}
    renamingName={renaming}
    pending={pending}
    textHeads={heads}
    onRequestText={request}
    onOpenFile={name => openListed(name)}
    onOpenDir={name => { setSelected(childPath(name)); enter(name) }}
    onGoUp={currentPath ? goUp : undefined}
    onContextMenu={name => setMenuName(name)}
    onClearMenu={() => setMenuName(null)}
    renderRename={name => <RenameField name={name} onSubmit={next => { setRenaming(null); void renameEntry(name, next) }} onCancel={() => setRenaming(null)} />}
/>
```

Do not mount this from `DesktopConversation` or `DesktopApp`. The Files dialog already renders `DesktopCoworkerFiles`.

After that mount, `DesktopCoworkerFiles.test.tsx` still looks for a hidden file with `[role="dialog"] li`. The grid has no `li`. Point that assertion at `[data-files-name=".env"]` or the button whose `aria-label` is `.env`. Tile buttons keep `aria-label` equal to the entry name, and the parent button’s `aria-label` is `..`, so the existing button click helper still finds `docs`, `notes.md`, `..`, and `.env`.

## Authored unrun regressions

| File | Locks | Run |
| --- | --- | --- |
| `model.test.ts` | Reserved names vs `.env`; image URL shape, identity, 3_000_000 cap, non-image, foreign base; text head slice 600; conflict and error become `''`; text thumbs exclude image, audio, video, PDF, zip, empty, oversized, and directories | NOT RUN |
| `DesktopFilesGrid.test.tsx` | Grid track, directory-first order, type icons, extension badge, image route, one image error then the sheet, text head vs empty head, in-view text request only, off-screen request skipped, reserved names omitted, open file vs folder, parent menu cleared, pending does not open, rename slot, empty sentence plus parent | NOT RUN |

## Checks NOT run

Tests, typecheck, lint, format, build, install, UI, browser, native app, live DB, Keychain, network, listeners, accounts, permission prompts, restart, guest, Docker, microphone. No push, no PR, no rebase.

## Hook

`core.hooksPath` is empty. `.git/hooks` contains only `*.sample`. The implementation commit was created. No hook-stop. Hooks were not bypassed.

## Risks

- An `<img>` to the Files image route sends the session cookie. A JSON refusal or a non-image body is an element error, then the sheet. It is not a successful thumbnail and it is not the preview screen.
- The text-head read is a second `GET /files/read` beside an open preview of the same path. They do not share state. A thumbnail miss does not clear the preview. A conflict body is not painted into the sheet.
- In-view observation does nothing when `IntersectionObserver` is missing, so no text head is requested. That is not treated as an empty successful read.
- Sorting changes order relative to the API list.
- A folder whose names are all reserved aliases shows the empty sentence instead of those names.

## Status

READY for root to apply the fragment. Gated on that mount and on root’s own checks. Not mounted in this commit. Not Mac acceptance. No PASS.
