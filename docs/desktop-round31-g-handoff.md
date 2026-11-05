# Round 31 G — E3 browser navigation and confined export source handoff

Branch: `desktop/round31-browser-exports`.
Exact parent: `136f318e931a4433ea6d178f3f9e961e1a2d8a86`.
Original source: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

This is an unexecuted source handoff. No tests, type checks, lint, builds, guest
decoder execution, Docker, app servers, external APIs, packaging, installations,
Mac UI, Keychain, live workspace access or restart checks were run. Root execution
and native acceptance are pending. E3 is not marked tested, accepted or complete.
There is no push, merge or publication.

## Changed files

1. `apps/engine/src/desktop/isolated-screen/types.ts`
2. `apps/engine/src/desktop/isolated-screen/page.ts`
3. `apps/engine/src/desktop/isolated-screen/service.ts`
4. `apps/engine/src/desktop/isolated-screen/tools.ts`
5. `apps/engine/src/desktop/isolated-screen/exports.ts` (new)
6. `apps/engine/src/desktop/isolated-screen/transport.ts` (new)
7. `apps/engine/src/desktop/isolated-screen/exports.test.ts` (new)
8. `apps/engine/src/desktop/isolated-screen/export-publication.test.ts` (new)
9. `apps/engine/src/desktop/isolated-screen/navigation-export-service.test.ts` (new)
10. `apps/engine/desktop-guest/guest.py`
11. `apps/engine/desktop-guest/guest_exports_test.py` (new)
12. `docs/desktop-round31-g-handoff.md` (new)

All changes are in G's permitted paths plus this document. No shared renderer,
contract export, registry, UI route, migration/bootstrap, provider, run/queue,
Control Center, lifecycle binding, packaging or other lane source was edited.

## Original implementation and necessary Mac adaptations

Read the actual pinned sources with `git show` before implementing:

- `apps/engine/src/tools/builtin/browser.ts`: `Visit`, `browserTools`, `readPage`,
  `readLinks`, `waitOutBotWall` and consent handling. Preserve `browser_navigate`,
  `url`, optional `screenshotPath`, `links: false`, `timeoutMs: 30000`, positive
  integer ceiling `120000`, ordered/deduplicated HTTP links (300, 80-character
  labels), and the existing text/bot-wall result. The accepted desktop structured
  page result is extended with an export receipt instead of replacing its shape
  with the hosted tool's free-form text.
- `apps/engine/src/tools/builtin/page-file.ts`: `PageToSave`, `PageView`,
  `pageFileBase`, `savePage`. Retain the saved rendered-HTML meaning. Do not port
  the host filesystem resolver, overwrite-by-URL writes, hidden recursive folder
  creation, best-effort swallowed save errors or pruning/deletion. The Mac saves
  one flat visible deterministic `browser-<32 hex>.browser.html.txt` per exact
  invocation; current Files write authority is mandatory. Raw rendered HTML is
  preserved as UTF-8 text, not sanitized into a different document and not served
  as trusted HTML. The `.txt` suffix intentionally prevents active HTML preview.
- `apps/ui/lib/files/preview.ts`: original image/text classification supports
  using the existing PNG frame and inert text preview. There is no new visual
  design, dialog, card, renderer or responsive layout in this lane. Existing
  narrow/short-width behavior remains with root's accepted Files/viewer UI.

Read the full `docs/desktop-round31-interfaces.md`, root `CLAUDE.md`, the supplied
AGENTS instructions, and the installed Next.js route-handler guide at
`/Users/gszulc/OpenBot/Shared/rerun-desktop/apps/ui/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`.
No Next.js route or UI module is changed. The assigned engine subtree has no
additional AGENTS/CLAUDE file. Existing accepted `binding.ts`, `frame.ts`,
`docker-cli.ts`, `identity.ts`, `encode.ts`, `service.ts`, `tools.ts`, guest and
current private Files publication helpers were read as local integration context.

## Implemented engine/guest boundary

`IsolatedScreenService.navigate(target, input, signal, exports?)` remains additive:

```ts
type ScreenNavigate = {
    url: string
    links?: boolean
    timeoutMs?: number
    screenshotPath?: string
}
type ScreenNavigationExport = {
    htmlPath: string
    publish(artifacts: ScreenExportArtifact[], signal: AbortSignal): Promise<ScreenSavedExports>
}
```

The existing framed guest `navigate` operation is extended, not replaced with
another route/session/controller. Its JSON carries only `url`, `links`,
`timeoutMs`, `screenshot` (boolean), `exportHtml` (boolean), and the existing
internal `requestId`. **No destination path, Mac filesystem resolver, arbitrary
expression, file read/write operation, browser endpoint or host port reaches the
guest.** The response has existing structured page fields plus `htmlBytes`,
`screenshotBytes`, `screenshotWidth`, `screenshotHeight`. Its existing binary
frame contains exactly UTF-8 HTML followed by optional PNG. Length mismatches,
missing output and surplus bytes refuse publication. Existing frame caps remain
unchanged (1,000,000 JSON bytes and 8 MiB binary).

Limits:

| Item | Limit/behavior |
| --- | --- |
| Navigation | Default 30,000 ms; integer 1–120,000 ms; one monotonic guest deadline includes page reading, wall/consent and export |
| Challenge wait | At most 15 seconds or half the requested timeout; static walls return immediately |
| Guest capture | At most 15 seconds, further bounded by remaining navigation time |
| HTML | Complete UTF-8, at most 1 MiB; oversized/invalid/NUL HTML is refused, never labeled whole after truncation |
| Full-page PNG | At most 8192 per edge, 16,777,216 pixels, 6 MiB encoded |
| Host PNG decode | Header/chunk/dimension checks before Sharp; APNG and trailing bytes refused; 5-second Sharp processing timeout and pixel cap; re-encode to stripped static PNG |
| Host publication | 30-second publisher observation deadline; service budget is navigation timeout + 35 seconds |
| Tool budget | Navigation timeout + 70 seconds including accepted screen startup and host processing |
| Destination | Visible relative path, 1024 characters total, 120 characters per segment; no hidden/dot/traversal/empty segments, backslashes, controls or absolute paths; exact `.png` or `.browser.html.txt` suffix |

Before capture the guest reads CSS content dimensions; after capture it checks
them again. Growth/shrinkage, PNG dimensions differing from the requested full
rectangle, over-budget output or elapsed capture time fail rather than returning
a crop called full-page. Device-scale mismatches are refused rather than resized
and mislabeled. Full-page means the current document layout rectangle; infinite
scroll, offscreen lazy content, closed shadow roots and content in nested scrolling
containers are not expanded. Same-size dynamic changes are not a frozen DOM
snapshot; HTML and screenshot are sequential bounded observations.

Bot walls retain existing wall detection and suppress exports and links. Consent
buttons use the accepted original selectors; they are not clicked through a known
bot wall. Refusing a bot-wall screenshot is a deliberate Mac difference from the
original optional screenshot-on-wall behavior: no partial export batch or wall
HTML is presented as a saved ordinary page. Use the existing viewer/takeover path.

Cancellation retains the same per-coworker service action lock, model ownership,
generation checks, takeover exclusion, Stop/revocation signal and guest cancel
request/acknowledgment path. CDP reads now poll cancellation during partial WebSocket
frames without discarding fragments. Fragmented message totals are bounded;
navigation event retention is bounded to 256 small status/load summaries rather
than retaining request headers. Current target checks occur after guest data,
after decoding and before/after publication. No raw HTML/PNG enters the model
result; only acknowledged relative paths, hashes and sizes do.

## Root integration: exact additive entry points

Root must supply the publisher. The current registry calls
`isolatedScreenTools(ctx)` at `apps/engine/src/tools/registry.ts`; that file is
unchanged. Its one-line integration is:

```ts
const screen = isolatedScreenTools(ctx, { publishExports: desktopBrowserExportPublisher })
```

`desktopBrowserExportPublisher` must implement the **exported existing source
type** `ScreenExportPublisher` from
`apps/engine/src/desktop/isolated-screen/transport.ts`. Do not duplicate its types
in a paired contract. It receives only a trusted engine invocation plus bounded
validated artifacts and an AbortSignal:

```ts
type ScreenExportIdentity = {
    engineAgentId: string
    sessionId: string
    runId: string
    toolCallId: string
    target: ScreenTarget
    url: string
}
type ScreenExportCall = ScreenExportIdentity & { artifacts: ScreenExportArtifact[] }
type ScreenExportPublisher =
    (call: ScreenExportCall, signal: AbortSignal) => Promise<ScreenSavedExports>
```

There is no root route mount in this patch and no new arbitrary filesystem RPC.
G's agreement specifies the guest operation but no export HTTP route. Root owns
the authenticated bridge/transport if the UI process holds Files authority. Do
not send the export callback through a renderer, reuse `fs_write` as though it
accepted PNG, route to the host browser, or create an unauthenticated file endpoint.
If transported across processes, preserve the exact source identity, enforce
body/framing caps before parsing (7 MiB binary maximum, no unconstrained JSON
Buffer expansion), revalidate byte hashes/types and never log payload bodies.
There is no hub authorization/header inheritance or hosted request here.

The provided `createScreenExportPublisher(deps)` supplies claim/replay logic.
Root binds it to the existing local authority, durable store and confined Files
publication primitive:

```ts
import { createScreenExportPublisher } from '../desktop/isolated-screen/transport.js'
import type { ScreenExportDependencies } from '../desktop/isolated-screen/transport.js'

export function bindBrowserExportPublisher(deps: ScreenExportDependencies) {
    return createScreenExportPublisher(deps)
}
```

The exact required dependency interface is exported in `transport.ts`:

```ts
type ScreenExportDependencies = {
    authorize(call: ScreenExportIdentity, signal: AbortSignal): Promise<{
        ownerId: string
        workspaceIdentity: string
        runIdentity: string
        launchNonce: string
    }>
    receipts: {
        read(key: string): Promise<ScreenExportReceipt | null>
        claim(key: string, digest: string): Promise<boolean>
        settle(key: string, digest: string, result: ScreenSavedExports): Promise<void>
    }
    createOnly(
        artifact: ScreenExportArtifact,
        authority: ScreenExportAuthority,
        guard: () => Promise<void>,
        signal: AbortSignal,
    ): Promise<void>
}
```

These callbacks are required root implementation, **not implemented authority or
filesystem guarantees merely because the types exist**:

1. `authorize`: freshly map engine coworker/session/run/tool-call to the exact
   local owner and current active invocation. Reject disabled/deleting owners,
   revoked browser/computer/privateFileWrite, mismatched session/run provenance,
   stale `target.launchNonce`/`sessionGeneration`, or human ownership. Return a
   stable workspace fingerprint containing the canonical workspace identity and
   immutable local owner; `runIdentity` pins the current run/source revision.
   A model/renderer supplied workspace path or boolean grant is never authority.
2. `receipts`: implement in root's durable database/migration ladder. `claim` is
   atomic insert-if-absent by exact opaque key; `settle` is compare-by-key-and-digest,
   durable and idempotent. Store metadata only, never HTML/screenshots. Root owns
   its schema name, exports and initialization; no competing table/schema is
   introduced here. Missing/unavailable storage must throw, not become an empty
   journal or a saved result.
3. `createOnly`: use the root Files mutation lock/deletion ordering, existing owned
   workspace and existing destination parent. Pin/recheck all ancestors and
   workspace inode identity; refuse symlinks and aliases and any existing final
   name (including a hardlink). Stage bounded bytes in the pinned owned directory,
   sync, call `guard` immediately before visibility, and atomically publish with
   no replacement. Refuse/recover only owned staged resources and never remove a
   foreign replacement. Check final identity/one-link ownership after staging is
   removed. Reject changed parents and interrupted file-operation journals.
   This is create-only: there is no overwrite exception, baseHash bypass, automatic
   suffix retry or replacement of an edited page/screenshot.

Existing source references for root's sink adaptation:
`apps/ui/lib/desktop/server/private-file-tools/publication.ts` already demonstrates
claim-before-write, exact-call receipts and live authority guards;
`coworker-files.ts` has `importCoworkerFile`, `importCoworkerRasterFile` and pinned
create-only import machinery. They are not interchangeable as supplied:
`importCoworkerFile` is text-only (1 MiB) and accepts `PrivateToolPublication`;
`importCoworkerRasterFile` is the raster path but does not expose the same complete
existing-directory/private-tool publication argument. Root must adapt the strict
publication primitive for PNG rather than assuming a raster upload grants model
write access or silently weakening the private-file checks. G did not edit these
root-owned files.

Root must retain its central run Stop/deletion/revocation wiring and the existing
isolated browser lifecycle. `beginDesktopAgentWork` covers the tool publication
observer, while **the root sink must retain its own work/deletion lease until any
late filesystem operation actually settles**. Guard checks and aborted signals
prohibit a late pending operation from publishing after cancellation. Engine
observer timeout does not mean a database/fs operation was physically cancelled.

No new grant is invented. Browser-only navigation still works with current
browser/computer grants when Files write is absent. Optional screenshots refuse
before navigation if the publisher/current write authority is unavailable;
HTML saving is reported `refused` or `unavailable` rather than claimed saved.
Root must update the existing catalog/system instruction text to describe the
original optional fields and current write requirement; no automatic grant.

## Durable and restart behavior

Publication keys include authoritative local owner plus exact session/run/tool
call; digests also bind target generation, URL and ordered artifact metadata/hashes.
The same pending call coalesces in-process. A settled durable receipt replays
without another write, subject to fresh authority. Different bytes or source
under the same identity refuse. A persisted `claimed` receipt after process death
returns `unknown`; no automatic re-execution, cleanup, new filename or overwrite.
A partial batch keeps only positively acknowledged file metadata and remains
`unknown`. Files remain ordinary private Files after restart; this lane adds no
auto-prune or background process and does not copy profiles or private contexts.

The publication helper does not persist or replay navigation, HTML bytes, PNG
bytes or a live browser target. Root's existing run/tool receipt machinery must
retain the actual tool result rather than re-executing an old navigation after
restart. A later call with a new run/tool identity may capture the then-current
page into a new HTML name. An old target is not revived to make receipt replay
look like current browser work. If a response is lost, inspect Files and the
durable receipt; an uncertain call must not be automatically retried as a new call.

## Root execution and honest limits

Authored cases only:

- `exports.test.ts`: original defaults/ceiling, links ordering/deduplication,
  path refusal, inert exact UTF-8, malformed/oversized/surplus bytes, cancellation,
  real Sharp-generated PNG fixture, dimension mismatch and trailing PNG refusal.
- `export-publication.test.ts`: concurrent exact calls, receipt replay/new
  publisher instance, uncertain claims, reused identity, create-only conflict,
  revoke/replaced workspace and Stop during a late claim.
- `navigation-export-service.test.ts`: no-writer navigation, explicit links,
  guest options without paths, verified bytes/receipt, invalid acknowledgments,
  takeover cancelling pending publication.
- `desktop-guest/guest_exports_test.py`: pure mocked guest options, dimensions,
  HTML byte limits, fragmented WebSocket aggregate cap, cancellation while reading
  and page-dimension change. It does not start Chromium, Docker or any server.

Root must execute these and the existing suites after integrating the dependencies.
The existing `service.test.ts` navigation assertion at the base assumes implicit
links; root must change that fixture invocation to `links: true` or expect `[]`
to reflect the requested original default. G did not edit that older test file.

Root must rebuild/package the guest with this changed `guest.py`; no extra Python
module/package needs to be added to its Dockerfile. An old guest has no export
response fields and is refused as incomplete rather than producing a fake save.
Sharp is already declared; no dependency was installed or version changed.
Root must verify the packaged Sharp decoder, Chromium full-document capture,
timeout/Stop/takeover/revocation races, exact writer/owner/parent confinement,
symlink/hardlink/changed-file refusal, durable lost-response/restart handling,
and the existing Files PNG/text preview in the native Mac app.

Unsupported: arbitrary filesystem paths/RPC, overwriting existing destinations,
creating missing parent folders/workspaces through export, active HTML rendering,
PDF/JPEG screenshot export, tiled/unbounded/infinite-page screenshots, guaranteed
same-instant DOM and screenshot, browser access to host profiles/ports/files,
export without current write authority, and automatic retry of uncertain saves.
The feature remains unaccepted until root supplies the sink/receipt/bridge wiring
and runs all checks/native acceptance. No checklist item is marked complete.
