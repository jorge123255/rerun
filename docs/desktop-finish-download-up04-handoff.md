# UP-04 / TL01 — public binary download

Source delivery only. Not Mac acceptance. No PASS.

## SHAs

| Role | SHA |
| --- | --- |
| Base (frozen pub `desktop/finish-cloud-base-20261106-8297fe64`) | `8297fe6404caa114dcb0c2cd6006291a8abb2038` |
| Implementation (this package) | `d5568e5e9904cbf4abe84b86d08fbcf351d66b1a` |
| Original pin, read only | `2a57fa6dd53311f763bfc9abde85997b7f7e5309` |
| Supplement pin, reference only, not merged | `ab3def9bfcf545cc9548f99c63c2b011ca094023` |
| Cloud integration `bc-714cd9be-c9ad-5527-b2ed-6e79b2a13a08` | not read, not rebased, not a dependency |

The handoff commit is the child of `d5568e5e9904cbf4abe84b86d08fbcf351d66b1a`. This file does not record its own SHA.

Branch: `desktop/finish-download-up04`. Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/finish-download-up04`. No push. No PR.

## Original paths

Pin `2a57fa6dd53311f763bfc9abde85997b7f7e5309`:

- `apps/engine/src/tools/builtin/web.ts` `download` tool, lines 167–190. Input `{ url: publicHttpUrl, path }`. `fetchPublic` with `maxRedirects: 10` (`MAX_REDIRECTS` at line 20). Success text `Downloaded N bytes to ${path}`. Over 50_000_000 bytes: `Download too large (N bytes, limit 50MB)` and no file. Non-OK: `Download failed: [status] url`. Abort rethrows. `../` throws `Path escapes the root`.
- `apps/engine/src/lib/public-fetch.ts` `fetchPublic` / `NonPublicHostError`. Default redirect cap inside `fetchPublic` is 3; the download call overrides it to 10.
- `apps/engine/src/tools/url.ts` `publicHttpUrl` (http/https only).
- `apps/engine/src/tools/builtin/web.gaps.test.ts` download cases, lines 115–164. Evidence of original outcomes. Not copied as an executed suite.

On this base, `apps/engine/src/tools/builtin/web.ts` lines 160–182 still define `download`, but with `fetch` and `writeFile`, not `fetchPublic`. `desktopApp()` in `apps/engine/src/tools/registry.ts` does not call `webTools`. That builtin is not the desktop path and was not edited.

## Changed paths

- `apps/engine/src/desktop/download-tools/binding.ts`
- `apps/engine/src/desktop/download-tools/download.ts`
- `apps/engine/src/desktop/download-tools/download.test.ts`
- `apps/engine/src/desktop/download-tools/errors.ts`
- `apps/engine/src/desktop/download-tools/index.ts`
- `apps/engine/src/desktop/download-tools/limits.ts`
- `apps/engine/src/desktop/download-tools/path.ts`
- `apps/engine/src/desktop/download-tools/publish.ts`
- `apps/engine/src/desktop/download-tools/reader.ts`
- `apps/engine/src/desktop/download-tools/reader.test.ts`
- `apps/engine/src/desktop/download-tools/tool.ts`
- `apps/engine/src/desktop/download-tools/types.ts`
- `docs/desktop-finish-download-up04-handoff.md` (this commit)

No UI module. No route. No edit to `DesktopApp`, `DesktopConversation`, `apps/engine/src/tools/registry.ts`, `packages/contracts/src/desktop-tool-grants.ts`, `coworker-files.ts`, or any other owner tree.

## Already there / new / gated

Already on the base, left in place:

- Catalog row `pending('web', 'Download files', 'Download remote content.', 'Requires a reviewed download destination.', 'download')` in `packages/contracts/src/desktop-tool-grants.ts` line 47. Unavailable reason stays exact until root applies the fragment below.
- `publicUrl`, `isPublicAddress`, and `publicDestination` in `apps/engine/src/desktop/web-fetch/public-url.ts`.
- `workspaceDir` in `apps/engine/src/config/paths.ts`. Coworker Files uses the same `<engine data>/agents/<id>/workspace` (`apps/ui/lib/desktop/server/coworker-files.ts` lines 38–44).
- Create-only publication pattern in private `importFile` (`coworker-files.ts` lines 616–738): `O_CREAT|O_EXCL`, Darwin `0x20000000` (`O_NOFOLLOW_ANY`, not combined with `O_NOFOLLOW`), `link(2)` so `EEXIST` does not replace, clash keeps the existing name, post-link identity failure is not success. `importFile` is text/raster only and is not called. Arbitrary bytes would be rejected there.
- `readPublicPage` stays text/HTML. Binary download does not use it and does not write `.rerun/pages`.

New: the package under `apps/engine/src/desktop/download-tools/`. Production publication is `publishDownload` into a real coworker workspace directory. Production read is `readPublicBinary` (direct public GET, no cookie jar, `agent: false`, certificate pinned to the original hostname).

Gated: `desktopDownloadTools` returns `{}` until `bindDesktopDownloadPermission` runs. The model still will not see `download` until root changes the catalog id and grant together. Unbound is unavailable, not a saved file.

## Behavior and limits

- One GET. The reader is called at most once. No host breaker, no retry, no `[attempt n/3]` trailer.
- Deadline 30s (`DOWNLOAD_DEADLINE_MS`). Cancellation throws and is not success. A timeout or late abort after a confirmed link returns `The download result could not be confirmed. Check Files before retrying.` and must not be retried as a new success. A retry that finds the name clashes and keeps the existing bytes.
- Public admission uses Mac `publicUrl` plus IP-literal `isPublicAddress` before any read. Hostname DNS runs only inside `readPublicBinary` via `publicDestination`. Redirects are followed at most 3 times (`DOWNLOAD_REDIRECT_LIMIT`), and each hop is admitted again. This is the Mac page-read cap. The original download call used 10.
- Body cap `50_000_000` (`Download too large (N bytes, limit 50MB)`). A declared `Content-Length` over the cap is refused before the body is read. Card and preview caps are unchanged; a saved file is not a preview.
- `Content-Encoding` other than `identity` is refused and not decoded.
- Non-2xx does not write. `401/403/407/429/>=500` are `failed`. `404` returns `Download failed: [404] url` with `failed: false`, matching `isFailureStatus`, and writes nothing.
- Success text, only after `link(2)` and a matching dev/ino, is `Downloaded N bytes to ${path}` using the workspace-relative path. No host path is returned.
- Destination must be workspace-relative. `..`, absolute paths, NUL, and backslash throw `Path escapes the root`.
- Any NFKC-folded segment starting with `.rerun` or `.rerun-skill` is reserved, at every depth. Ordinary dotfiles such as `.cache/notes.bin` are allowed.
- Refused types, before publish: extensions `app`, `bat`, `bash`, `cmd`, `com`, `command`, `csh`, `dll`, `dylib`, `exe`, `fish`, `ksh`, `msi`, `ps1`, `scr`, `sh`, `so`, `zsh`, and content types `application/x-executable`, `application/x-mach-binary`, `application/x-dosexec`, `application/x-msdownload`, `application/x-msdos-program`, `application/vnd.microsoft.portable-executable`, `application/x-sharedlib`, `application/x-pie-executable`, `application/x-elf`, `application/x-sh`, `application/x-shellscript`, `text/x-shellscript`, `text/x-script`. Message: `That file type can’t be downloaded.` Archives, images, PDF, and `.bin` are stored as opaque bytes and are not unpacked or executed. Mode is `0o644`.
- Existing name, including a symlink, is kept: `This folder already has a file named “name”. The existing file was kept.`
- Symlink ancestors, a non-canonical workspace (`realpath` differs), or another user's directory are refused with `That path is outside this coworker’s workspace.` or `This file belongs to another user. It was left unopened.`
- Staging name is `.rerun-download-<24 hex>` in the destination directory and is unlinked after the attempt. It is a reserved `.rerun*` name, not the user file.
- The workspace directory must already be named `workspace`. `publishDownload` creates that directory only when its parent is a real directory owned by the current user. It does not create the agent directory.
- Alias refusal is at publication. The body is not written through the link.

## Root fragments

Root applies these. This package does not mount them.

Catalog and grant, `packages/contracts/src/desktop-tool-grants.ts`. Add `'download'` to `desktopRerunGrantIds` immediately after `'webSearch'`. Replace the pending row. Do not add a grant id named `web`. Admission in `apps/engine/src/agents/providers.ts` is `grants[entry.id]`, and `web` is not a grant id. The zod grant record strips unknown keys, so no stored `web: true` needs a migration.

```ts
supported('download', 'Download files', 'Download a public file into this coworker’s Files. The file is not executed or unpacked.', 'download'),
```

Leave the pending row, including `Requires a reviewed download destination.`, until this replacement, the permission bind, and the registry spread land together.

`apps/engine/src/desktop/tool-grants.ts`, inside `hasDesktopToolGrant`, so ephemeral and foreman coworkers do not get a durable Files destination:

```ts
if (id === 'download') return !config.ephemeral && config.kind !== 'foreman'
```

Instruction text while that grant is on:

```ts
'download saves one public HTTP(S) file into this coworker’s Files. It does not execute or unpack the file, does not replace an existing name, and does not save a page under .rerun/pages. Report the tool result; a refusal, clash, or unconfirmed result is not a completed download and must not be retried automatically.'
```

Registry, `apps/engine/src/tools/registry.ts`, desktop branch only, beside `...desktopWebFetchTools(ctx)` (line 78 on this base):

```ts
import { desktopDownloadTools } from '../desktop/download-tools/tool.js'
import { bindDesktopDownloadPermission } from '../desktop/download-tools/binding.js'
import { requireDesktopToolGrant } from '../desktop/tool-grants.js'

// once, at desktop startup, after 'download' is a DesktopRerunGrantId:
bindDesktopDownloadPermission(async ctx => {
    await requireDesktopToolGrant(ctx, 'download')
})

// inside the desktopApp() tool set:
...desktopDownloadTools(ctx),
```

Do not spread `webTools(ctx)` into the desktop set. No new HTTP route. `workspaceDir(coworkerId)` is the file root. `importCoworkerFile` stays text/raster.

## Authored unrun regressions

Not executed in this lane.

`apps/engine/src/desktop/download-tools/download.test.ts` uses the real `publishDownload` under a canonical temp `workspace` and an injected reader. It does not call `readPublicBinary`. Cases: original 4-byte `assets/raw/a.bin` receipt and no execute bit; ordinary `.cache/notes.bin`; 404 and 503 write nothing and do not retry; 50_000_001 bytes write nothing; `file:`, localhost, `127.0.0.1`, non-80/443, credentials, and `.local` do not call the reader; `../`, `.rerun/pages`, `.rerun-skill-pack`, `.exe`, and `.app` segments fail before the reader; executable content-type and a private final URL write nothing; clash keeps the old bytes; a directory symlink is not followed; abort before or during the read throws `aborted` and writes nothing; one network error is not retried; a permission error writes nothing; `desktopDownloadTools` is `{}` while permission is unbound.

`apps/engine/src/desktop/download-tools/reader.test.ts` mocks `node:http`, `node:https`, and `node:dns/promises`. Cases: connect to the admitted address with `Host`, `Accept: */*`, and `Accept-Encoding: identity`; do not follow a redirect to `127.0.0.1`; refuse a private literal before connect; return 404 with an empty body; refuse `application/x-mach-binary` before the body; refuse a declared length of 50000001.

## Checks not run

Tests, typecheck, lint, build, install, fixtures, and formatters were not run. No DNS, fetch, listener, UI, browser, native, database, Keychain, or permission prompt was used. No `--no-verify`.

## Hook-stop

No hook ran. `rerun-desktop/.git/hooks` contains only `*.sample` files. The implementation commit was created. There was no hook blockage.

## Risks

- Spreading `webTools` on desktop would expose the builtin `fetch` + `writeFile` download. Use `desktopDownloadTools` only.
- A crash after `link(2)` and before the tool returns can leave the file without a success receipt. The next attempt keeps that file.
- If unlinking `.rerun-download-*` fails, a hidden reserved name can remain on the same inode. Portable capture already excludes `.rerun*`.
- A deadline that fires after a confirmed link is reported as unconfirmed, not as `Downloaded`.
- The workspace path must be canonical. A data root reached through a symlink is refused, same as `coworkerWorkspace`.
- This package cannot call `hasDesktopToolGrant(..., 'download')` until the grant id exists. Binding twice throws.
- 50MB files are not card previews. Preview caps stay where they are.
- Duplicate grant / credential inheritance is unchanged root SPEC/SOURCE. No forbid-copies policy was added.

## Unsupported

No public listener or host. No path escape. No execute bit and no unpack. No cookie jar and no proxy agent. No `.rerun/pages` save. No overwrite. Compressed bodies are not inflated. `importCoworkerFile` is not a binary publisher. No UI receipt component; chat already shows the tool text, and Files lists the workspace file.
