# Round 31 G — expanded E3 browser options and exports handoff

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round31-browser-exports`.
Branch: `desktop/round31-browser-exports`.
Prepared base: `136f318e931a4433ea6d178f3f9e961e1a2d8a86`.
Prior local handoff preserved: `2e00ceb0cc6352eee3ef743f996b93d02d6a14d3`.
Original pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

This continues the existing dispatch; no reset, switch, squash, cherry-pick or other
lane edit was performed. The final SHA is reported in the chat handoff. This file
supersedes the prior version of this document, including its flat HTML filename,
no-metadata description and two-artifact publication signature.

**Source implementation and authored regressions only.** No tests, type checks,
lint, builds, decoder execution, guest/Chromium, Docker, app servers, external API
calls, Keychain, live workspace reads, installations, packaging, native UI or
restart checks were executed. Root runs every check and native acceptance.
No push, merge, deployment or publication. E3 is not tested, accepted or marked
complete, and no shared checklist count is changed.

## Owned changed files, cumulative from the prepared base

1. `apps/engine/src/desktop/isolated-screen/types.ts`
2. `apps/engine/src/desktop/isolated-screen/page.ts`
3. `apps/engine/src/desktop/isolated-screen/service.ts`
4. `apps/engine/src/desktop/isolated-screen/transport.ts`
5. `apps/engine/src/desktop/isolated-screen/tools.ts`
6. `apps/engine/src/desktop/isolated-screen/exports.ts`
7. `apps/engine/src/desktop/isolated-screen/exports.test.ts`
8. `apps/engine/src/desktop/isolated-screen/export-publication.test.ts`
9. `apps/engine/src/desktop/isolated-screen/navigation-export-service.test.ts`
10. `apps/engine/src/desktop/isolated-screen/navigation-protocol.ts`
11. `apps/engine/src/desktop/isolated-screen/navigation-protocol.test.ts`
12. `apps/engine/src/desktop/isolated-screen/export-metadata.ts`
13. `apps/engine/src/desktop/isolated-screen/export-metadata.test.ts`
14. `apps/engine/src/desktop/isolated-screen/export-retention.ts`
15. `apps/engine/desktop-guest/guest.py`
16. `apps/engine/desktop-guest/guest_exports_test.py`
17. `docs/desktop-round31-g-handoff.md`

No paired contracts, central exports/schema/registry, provider/run/queue/admission
or lifecycle integration, route mounts, shared UI/renderers, Control Center,
packaging, installed app, credentials or round30 worktrees were changed.

## Source mapping and Mac adaptations

Read the actual original source via `git show` at the pin before editing:

| Original source | Reused behavior | Necessary Mac adaptation |
| --- | --- | --- |
| `apps/engine/src/tools/builtin/browser.ts`: `Visit`, `browserTools` | `browser_navigate`, `url`, optional `screenshotPath`, `links=false`, `timeoutMs=30000`, positive integer ceiling 120000 | Existing isolated service/guest only; strict option schema; no host Patchright/browser/profile/mount access |
| Same file: `readLinks` | Unique HTTP(S) destinations in document order, whitespace-normalized 80-character labels, 300-link cap, `Links:` / `none` notes | Additional 160 KiB aggregate link budget, credential/transport destination filtering, explicit truncation |
| Same file: `readPage`, `waitOutBotWall`, `settle`, `acceptCookieBanner` | Main-document HTTP status, final URL, 50,000 visible-text limit, existing wall/consent selectors, render settling and save notes | One guest deadline; main-frame status tracking; bounded 5-second resource settling, no exports for a blocked/failed/unknown-status page; errors remain errors |
| `apps/engine/src/tools/builtin/page-file.ts`: `pageFileBase`, `savePage`, `PageView` / `PageToSave` | Private `.rerun/pages`, original host/path/index/query-loss hierarchy, browser rendered-HTML view, URL/status/final URL/time metadata, 30-day / 200 MiB retention intent | Complete HTML is inert `.html.txt`; immutable attempt and full-URL hash suffixes; per-attempt `.meta.txt`; no blind overwrite, cross-view metadata mutation, broad walk or deletion |
| `apps/ui/lib/files/preview.ts` | Existing image/text classification | PNG and inert UTF-8 text use existing Files previews; no new visual design, card, dialog or responsive layout |

Read the full round31 agreement, applicable supplied AGENTS instructions, root
`CLAUDE.md`, current isolated-screen modules and guest, authority/deletion binding,
private-file publication/binding and Files import primitives. The engine subtree
has no additional AGENTS/CLAUDE file. The installed Next.js route-handler guide
was read at `/Users/gszulc/OpenBot/Shared/rerun-desktop/apps/ui/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`.
No UI/Next route is authored here. H's passive viewer is unchanged; original
responsive behavior remains with the accepted UI, pending root native checks.

## Exported source surface and strict guest protocol

The exact types live in `types.ts`, `navigation-protocol.ts` and `transport.ts`;
root should import them rather than invent another document/browser protocol.

```ts
navigate(target: ScreenTarget, input: ScreenNavigate, signal: AbortSignal,
         exports?: ScreenNavigationExport): Promise<ScreenPage>

// types.ts
// ScreenNavigate: {url, links?, timeoutMs?, screenshotPath?}
// ScreenNavigationExport: {htmlPath, publish(artifacts, signal)}
// ScreenExportArtifact: kind/path/mediaType/bytes/sha256 plus PNG dimensions
// ScreenSavedExports: status/files plus bounded failure category
```

Other exported helpers/factories:

- `navigationOptions`, `exportPath`, `decodePageExports` (`exports.ts`).
- `PAGE_OPTIONS_VERSION=1`, `LINKS_BYTES_MAX`, `parseGuestNavigation`
  (`navigation-protocol.ts`).
- `publicUrl`, `safePageLink`, `boundPage`, `formatScreenPage` (`page.ts`).
- `browserPageBase`, `browserHtmlPath`, `browserMetadataArtifact`,
  `PAGE_EXPORT_ROOT`, `PAGE_METADATA_MAX`, `PAGE_RETENTION` (`export-metadata.ts`).
- `planBrowserExportRetention` / `BrowserExportRetentionRecord`
  (`export-retention.ts`).
- `createScreenExportPublisher`, `createScreenExportReader`,
  `screenExportIdentity`, `screenExportFailure`, `validateScreenExportManifest`,
  `validateScreenExportResult`, and their injected dependency types (`transport.ts`).

The existing framed guest `navigate` operation is extended in place. Its only
request fields are `op`, existing internal `requestId`, `pageOptionsVersion=1`,
`url`, `links`, `timeoutMs`, `screenshot` and `exportHtml`. The last two are booleans;
no workspace path, arbitrary expression/command or filesystem operation reaches
the guest. Guest and host reject unknown/incorrect fields and invalid bounds.

A successful response carries `ok`, matching version, main-document `status`,
`finalUrl`, bounded `text` and wall-detection `html`, `truncated`, bounded `links`,
`linksTruncated`, `htmlBytes`, `screenshotBytes`, `screenshotWidth`,
`screenshotHeight`, and at most two typed `exportErrors` (one per output kind).
Binary data is exactly UTF-8 HTML followed by PNG. Frame caps are unchanged:
1,000,000 JSON bytes and 8 MiB binary. Host validates lengths, UTF-8, raster
structure and decoder output before passing artifacts to root publication.
Metadata is generated on the host, never supplied as guest authority.

`ScreenPage.outcome` is `ok`, `blocked` or `failed`; unknown HTTP status (0) is
conservatively failed. The model-facing tool result keeps `page`, adds original
formatted `text` notes and `failed`, and never contains raw HTML/PNG. `Saved whole`
and `screenshot saved` refer only to acknowledged files. Partial failures state
that only acknowledged files were saved. Capture failure can preserve valid HTML
(and vice versa) with an explicit unknown/capture-failed outcome. Full-disk,
conflict, revocation, transport and invalid-acknowledgment categories are bounded;
raw exception bodies/paths/headers are not returned or logged.

Old guests without the versioned response are explicitly incompatible even for
ordinary navigation. Root must rebuild/install the current guest before wiring
this version. There is no silent assumption that the old fixed timeout honors
the new option. No extra guest module/package or Dockerfile edit is required.

## Bounds and navigation/control behavior

| Boundary | Bound |
| --- | --- |
| Navigation | Default 30000 ms, integer 1–120000 ms; one monotonic guest deadline covers navigation, settling, consent, wall polling and capture |
| Render settling | At most 5 seconds per settle, at most 512 active resource IDs; original 500 ms quiet intent; no retained request headers |
| Wall polling | At most 15 seconds / half requested timeout, within whole deadline; static wall returns immediately |
| Text / links | 50000 visible text characters; 300 links, 80 label characters, 160 KiB link JSON; truncation reported |
| Full-page PNG | At most 8192 on each edge, 16,777,216 aggregate pixels and 6 MiB encoded; capture at most 15 seconds within remaining guest deadline |
| Host decode | Header/dimension/chunk/APNG/trailing-byte checks before Sharp; 5-second pixel-limited decode/re-encode; publisher also validates raster bytes |
| HTML / metadata | Complete valid UTF-8 HTML at most 1 MiB, metadata at most 16 KiB; no NUL; no silently truncated whole-file claim |
| Host service / publisher | Service timeout is requested navigation + 35 seconds; publisher observation max 30 seconds; read-only recovery max 15 seconds |
| Tool incl. startup | Requested navigation + 70 seconds; all paths remain cancellable |
| Guest CDP memory | 9 MiB aggregate fragmented-message cap; 256 small main-document/load summaries; no cookie/header supplemental metadata |

Main-document responses are filtered by the navigation's frame ID so an iframe
cannot replace page status. Browser tab/profile selection stays with the accepted
guest. Consent selectors and wall markers are retained. HTTP failure, wall,
timeout, corrupt response or unknown status cannot be reported as a usable saved
page. Screenshot failures are not relabeled viewport captures.

The guest checks layout dimensions before expensive capture and checks them
again afterwards. Mismatched PNG dimensions, changing layout size, output/decode
limits and elapsed limits refuse the screenshot. A successful export additionally
rejects a changed final URL. Full-page means the current document layout rectangle;
it does not expand infinite scrolling, hidden lazy content or nested scrolling
containers. HTML and PNG are sequential observations, not a frozen same-instant DOM.
Known walls suppress exports; existing takeover/viewer remains the way to inspect
or clear them. This deliberately refuses original screenshot-on-wall behavior.

Existing action locks, per-run screen ownership, human takeover exclusion,
generation/launch checks, owner revocation, guest cancel request/tombstone/ack and
Stop behavior remain. CDP partial-frame reads poll cancellation without losing
fragments. Publication sees the same linked signal and current-target checks;
a delayed old capture cannot become output for a replacement generation. There
is no H subscription/control change, host port, CDP connection or host browser.

## Artifact layout, collision/retention and current Files dependencies

Automatic rendered HTML is deterministic for an exact URL and invocation:

```text
.rerun/pages/<original URL base>-<full URL hash>.browser-<attempt hash>.html.txt
.rerun/pages/<same base and attempt>.meta.txt
```

The URL base retains the original host/path/index and lossy/query hash logic;
very long hierarchies use a bounded hash fallback. Full URL and attempt suffixes
avoid cross-URL collisions and keep previous/user-edited snapshots intact.
Metadata retains `{url, views:{browser:{file,savedAt,status,finalUrl,contentType,
sha256,byteLength}}, screenshot?}`. Other original served/rendered views are not
rewritten or merged with untrusted sidecars. Metadata remains inert untrusted
text, never a grant or ownership proof. Existing files are always preserved.

Explicit screenshots allow only visible relative `.png` paths with existing
parents. Only generated HTML/metadata may use the narrow `.rerun/pages` namespace.
No traversal/dot/empty segment, backslash, control, absolute path, symlink,
hardlink alias, changed parent/owner or replacement overwrite is permitted.
Paths are bounded to 1024 characters, ordinary segments 120 and generated cache
segments 200. Root must safely provision/pin only the deterministic cache parents
inside an already-authorized existing private workspace; no guest mkdir RPC or
new owner/workspace creation is allowed. This is an explicit root sink/migration
dependency, not a filesystem implementation hidden inside G.

`PAGE_RETENTION` passes the original 30-day / 200 MiB intent into the atomic claim.
Root must reserve aggregate owned bytes with the claim, refusing over-budget
storage (`EXPORT_BUDGET`/`EDQUOT`) rather than silently growing without limit.
`planBrowserExportRetention` accepts at most 4096 root-authenticated durable
operation records and returns exact key/digest candidates; it performs no I/O.
Changed, active, future-dated and foreign records are preserved. Root's existing
retention authority may remove only still-owned unchanged artifacts after fresh
inode/hash/owner checks; otherwise reject the new export. No directory traversal,
auto-prune timer, deletion of unrelated views or cleanup of replacement files.

**Concrete adjacent accepted behavior requiring root changes:**
`apps/engine/src/desktop/workspace-read.ts` `validPath` rejects hidden segments, so
plain `fs_read` cannot read the original `.rerun/pages` cache. Root must wire an
exact-receipt bounded cache read/Files preview path before activating save/read
notes; do not widen ordinary `validPath` to every hidden file. A saved .txt can be
rendered only as escaped/plain text. Root must preserve the original cache's
exclusion from templates/capture/share. G does not edit these central paths.

Root Files source references:
`apps/ui/lib/desktop/server/coworker-files.ts` has pinned/create-only import
machinery; `private-file-tools/publication.ts` and `binding.ts` show authenticated
exact-run authority and durable publication. Existing `importCoworkerFile` is
text-only and its strict private-tool path accepts visible paths. The raster
import does not expose the same full private-tool publication argument. Root
must provide a strict generated-cache/PNG sink using those protected primitives;
calling a generic raster upload is not write permission. G does not silently
relax uploads, hidden paths or shared Files policy.

## Precise root wiring

The existing registry integration remains one additive call; registry is unchanged:

```ts
const screen = isolatedScreenTools(ctx, { publishExports: desktopBrowserExportPublisher })
```

`desktopBrowserExportPublisher` implements the source `ScreenExportPublisher` type.
Root owns its authenticated bridge when Files authority is in the UI process.
There is no G-defined export HTTP route in the agreement, so none is invented.
Transport at most 1 MiB HTML + 6 MiB PNG + 16 KiB metadata, with bounded metadata/
headers and hashes checked before storage. Do not serialize Buffer objects into
unbounded JSON arrays, expose an arbitrary file RPC, log bodies or inherit hosted
hub headers. Renderer/model grants/paths cannot choose the owner or run.

Import and inject the actual source types/factories:

```ts
import {
    createScreenExportPublisher, createScreenExportReader,
    type ScreenExportDependencies, type ScreenExportReadDependencies,
} from '../desktop/isolated-screen/transport.js'

export function bindBrowserExports(
    publication: ScreenExportDependencies,
    history: ScreenExportReadDependencies,
) {
    return {
        publish: createScreenExportPublisher(publication),
        readAttempt: createScreenExportReader(history),
    }
}
```

Required dependency semantics (these types alone do not implement storage):

- `authorize(identity, signal)` freshly resolves exact engine/local owner,
  session/run/tool-call and source, enabled/deleting state, current browser,
  computer and privateFileWrite grants, target launch/generation and absence of
  human control. Its `{ownerId,workspaceIdentity,runIdentity,launchNonce}` pins
  immutable owner, canonical workspace inode/location and current source. Both
  tool and publisher recheck authority; sink calls `guard` at final visibility.
- `receipts.read(key)` reads durable exact-attempt state. `claim(key,digest,details)`
  atomically inserts absent state and reserves storage budget. `details` includes
  canonical server-only `source`, `sourceFingerprint`, ordered `files` manifest
  and `retention`. Persist these, not HTML/PNG bytes; old internal target identity
  must remain recoverable privately. `settle(key,digest,result)` is durable,
  compare-by-digest and idempotent. Storage unavailability/corruption throws;
  never treat it as an empty store or successful acknowledgement.
- `createOnly(artifact,authority,guard,signal,{key,digest,index})` retains root's
  actual work/deletion lease, pins parents without links, stages/syncs exact
  bounded bytes, durably records exact stage/final inode ownership under that
  operation/index, calls guard immediately before publishing and atomically
  creates without replacement. Confirm final identity/one-link ownership after
  removing the exact owned staging name. Refuse journals, moved parents, foreign
  replacements and any existing final name. Root may safely provision generated
  cache directories only; explicit screenshot parents must exist. Cleanup only
  exact owned resources, even after a lost reply or cancellation.
- Optional publication `reconcile(operation,authority,guard,signal)` inspects only
  that operation's existing receipt/stage/final identities. It never navigates,
  captures, creates a new final file, overwrites, or infers ownership from matching
  names/hashes alone. Match persisted key/digest/index, inode, size, hash, single
  link and owner; report only verified acknowledged files. Persist its result.
- History uses separate `authorizeRead` and required `reconcile`, plus receipt
  reads. It checks authenticated current owner/session/read authority while
  allowing an ended historical run and old guest generation. It never grants
  write or resumes that run. Root loads private `source` from the owned record,
  not a renderer-supplied engine target. `readAttempt` has no browser/capture or
  create callback and does not mutate receipt storage.

Root owns numbered migrations/bootstrap, budget/receipt/operation tables and
shared exports, bridge authentication/routes, current target/run authority,
protected sink/cache read, catalog/system instruction text, stop/revoke/delete
wiring, packaging and guest rebuild. Do not supply the publisher until these
concrete dependencies exist. Navigation without export works with only existing
browser/computer authority; screenshot requests refuse when write/publisher is
absent and implicit HTML saving reports refused/unavailable. No new grant.

## Retry, restart, cancellation and errors

Publication keys bind authoritative local owner + session/run/tool-call; digests
bind canonical source/target/options and ordered artifact hashes/sizes. In-process
exact calls coalesce. A completed exact receipt replays without writes; different
bytes/options/source under that identity refuse. Claimed/unknown attempts may be
read-only reconciled from exact operation ownership. Without a reconciler they
remain honestly unknown, with no automatic new path, overwrite or capture.
Partial batches retain acknowledged files and static failure category. A lost
reply after commit can be recognized after restart from the durable operation
record; user-edited/replaced/hardlinked files cannot be silently reclaimed.

Root run/tool receipt recovery must retain the actual tool outcome rather than
replay navigation. The history reader validates persisted source and manifests,
rechecks read ownership, and inspects existing operation records only. It never
starts a stopped guest or creates a replacement target. Existing artifacts remain
private Files after restart; read/preview/polling performs no browser action.

Observer deadlines/Stop do not physically cancel an already-issued filesystem or
SQLite syscall. Pending operation identity stays reserved until it actually
settles. Root's sink must retain its own lease, use the aborted guard before
visibility and record late completed ownership even when the caller already
returned unknown. The engine action/target signal prevents stale results; only
root can safely clean exact late staging resources. No claim is discarded to
allow a competing retry. No raw host paths, headers, cookies or secrets are
added to output, logs or another coworker's environment.

## Implemented / dependent / unsupported matrix

| Task | Implemented owned source | Required root dependency | Unsupported / deliberately refused |
| --- | --- | --- | --- |
| 1 options/protocol | Strict original fields/defaults, versioned guest response, formatter | Catalog/worker result wiring; current guest | Old guest response, unknown fields, arbitrary command/fs RPC |
| 2 page semantics | Main-frame status/final URL, bounded settle/consent/wall, failed outcomes | Real browser/redirect/consent QA | Unknown status saved as usable, failed/wall HTML exports |
| 3 links | Unique ordered HTTP links, original caps, aggregate budget, notes | Worker display checks | Credentials/internal transport metadata; unbounded list |
| 4 screenshot | Guest full-document capture, dimensions/pixels/bytes/time, host static PNG decode | Packaged guest/Sharp and actual capture QA | Oversize/crop/APNG, tiled/infinite capture, device-scale mismatch |
| 5 HTML/metadata | Complete inert bytes, URL/view metadata, deterministic cache names, owned retention planner | Protected cache parents/read, exclusion and quota/retention integration | Active HTML, blind overwrite or broad prune, mutation of unrelated views |
| 6 publication | Current injected guard, manifest/digest/claim, exact-operation sink/reconcile API | Actual authenticated run/write authority, protected Files sink, durable store | Renderer permission, changed file/parent, links/aliases, new workspace |
| 7 races | Existing generation/action/takeover/cancel path; publication linked signal | Root lifecycle/sink drain and exact resource cleanup | Publishing delayed old target/run into replacement |
| 8 recovery | Exact receipt coalescing/replay, read-only historical reconciliation factory | Durable operation inode records, history authority/cache read | Auto-recapture/re-navigation, ownership inferred from path/hash alone |
| 9 regressions | Six focused host/guest source suites described below | All execution and real filesystem/race checks | Any tested/pass/acceptance claim by G |
| 10 handoff | Full source map, API surface, wiring, limits and this matrix | Root integration/build/install/native/full restart acceptance | Marking full E3 complete or changing checklist counts |

## Authored and unrun regression sources

- `exports.test.ts`: options/defaults/bounds, path refusal, inert UTF-8, oversized/
  truncated/surplus data, cancellation, Sharp-generated PNG fixture, dimensions
  and trailing bytes. No decoder was executed here.
- `navigation-protocol.test.ts`: strict/version/extra fields, redirect URL,
  ordered/capped links, aggregate budget, credential/internal URL refusal,
  Cloudflare wall, `Links: none`, acknowledged save/partial-failure notes.
- `export-metadata.test.ts`: original URL layout/query/collision behavior,
  immutable attempt names, URL/browser-view metadata and conservative owned
  retention preserving edited, active and foreign rows.
- `export-publication.test.ts`: exact-call concurrency/replay, unknown claims,
  changed identity and existing names, revoke/replaced workspace, late claim
  after Stop, lost reply reconciliation/new reader, wrong owner, corrupt
  inventory, simulated hardlink/replacement identity and sink error categories.
- `navigation-export-service.test.ts`: no-writer navigation, guest options
  without paths, exact bytes/metadata acknowledgement, HTTP/wall refusal,
  partial screenshot failure, corrupt/old/timeout responses, takeover and
  Stop/replacement generation invalidation.
- `guest_exports_test.py`: pure mocked options/version/unknown fields, main frame
  vs iframe/final redirect status, render deadline, bounded event/resource
  retention with no headers, whole HTML limits, full-page dimensions, fragmented
  CDP aggregate cap, cancellation and changed screenshot dimensions. These tests
  do not start a guest/Chromium/server when root runs them.

The link/hardlink/parent cases are explicitly fake-sink/identity regressions, not
claims that the not-yet-bound native filesystem sink has passed races. Root must
execute real protected Files race/full-disk/lost-ack and full-restart checks.
Existing base `service.test.ts` fixtures assume the old response/default implicit
links: root must adapt them to versioned response fields, explicit links and new
outcome fields. That older test file is not modified here. Root owns repairs and
runs all tests/type checks/lint/builds, guest rebuild/install, live worker/browser,
Files, Mac board and restart acceptance. No package install or dependency change
was made in this lane.
