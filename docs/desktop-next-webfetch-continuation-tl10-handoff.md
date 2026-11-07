# TL10 — saved full-page continuation for truncated `web_fetch`

Source package only. **No Mac acceptance or validation claim.** No tests, typecheck, lint, build, install, executable fixture, formatter execution, provider/network activation, UI/browser/native action, live DB, Keychain, listener, account/permission prompt, restart, guest/Docker or microphone action was run. No push, PR, rebase, cherry-pick, deploy, release or publication occurred.

## Coordinates and consumed revisions

- **Worktree:** `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-webfetch-continuation-tl10`
- **Branch:** `desktop/next-webfetch-continuation-tl10`
- **Frozen base verified clean before editing:** `8297fe6404caa114dcb0c2cd6006291a8abb2038` (`desktop/finish-cloud-base-20261106-8297fe64`)
- **Implementation commits:** `bd78471828ecbf970c739d045c3d70aa97fa85b6`, reserved-root correction `814ec93242aa4b2c0d46e0dceb492a1d88ab62d7`, metadata-failure correction `7ce51dc052f6a67ff85793abae95bf30f99e2514`
- **Implementation SHA for integration:** `7ce51dc052f6a67ff85793abae95bf30f99e2514`
- **Original reference read-only:** `2a57fa6dd53311f763bfc9abde85997b7f7e5309`
- **Supplement read-only:** `ab3def9bfcf545cc9548f99c63c2b011ca094023`
- **Cloud integration not consumed or modified:** `bc-714cd9be-c9ad-5527-b2ed-6e79b2a13a08`
- **PR4 validation tree, Codex root and master:** not edited or executed
- **Commit-hook stop:** none. The implementation commit completed without `--no-verify`; no prohibited hook execution was observed.

## Original and existing-source mapping

| Source | Evidence used | Package behavior |
|---|---|---|
| Original `apps/engine/src/tools/builtin/web.ts` | `savePage` is called with the full served body before `MAX_FETCH_CHARS` is applied; `savedLine` points the coworker to that whole copy. | Save the already-read body before truncation. No second request, guessed hub or rendered fallback. |
| Original `apps/engine/src/tools/builtin/page-file.ts` | `.rerun/pages`, original host/path/index/query hashing, served/rendered distinction, full body plus URL/view metadata, collision avoidance and retention intent. | Distinct `served-html` + `page-metadata` artifacts with full-URL and invocation hashes, inert `.txt` bytes and `views.served` metadata. Existing publisher retention applies. |
| Current `apps/engine/src/desktop/web-fetch/index.ts` | Bounded public-page result currently says `no full copy saved`. | Optional `saveWebFetchContinuation` and `webFetchContinuationNote` preserve the old output when unbound, emit `Saved whole` only for a validated saved receipt, and otherwise report an unconfirmed save honestly. |
| Existing `isolated-screen/export-metadata.ts` | `browserPageBase`, `PAGE_METADATA_MAX`, `PAGE_RETENTION` and current inert browser-export conventions. | Reuses the URL hierarchy and metadata cap; does not relabel served HTML as browser-rendered HTML. |
| Existing `isolated-screen/transport.ts` and UI `browser-exports` | Exact invocation receipts, create-only publication, collision checks, recovery and readback. | New `publish-web-fetch` operation reuses those stores and checks with web-fetch-specific authorization. No second database or filesystem store. |

The saved copy is a continuation aid, not a grant or a trusted fact. Page and metadata text remain untrusted content. Portable capture/share exclusions for `.rerun*` / `.rerun-skill-*` remain unchanged; ordinary hidden user assets are not broadly excluded by this package.

## Changed paths

- `apps/engine/src/desktop/web-fetch-continuation/index.ts`
- `apps/engine/src/desktop/web-fetch-continuation/continuation.ts`
- `apps/engine/src/desktop/web-fetch-continuation/client.ts`
- `apps/engine/src/desktop/web-fetch-continuation/continuation.test.ts`
- `apps/engine/src/desktop/web-fetch-continuation/client.test.ts`
- `apps/engine/src/desktop/web-fetch-continuation/result.test.ts`
- `docs/desktop-next-webfetch-continuation-tl10-handoff.md`

No central tool registry, grant enum, contract barrel, migration number, DesktopApp, DesktopConversation, composer, packaging identity or other worktree was edited.

## Contract and lifecycle

- `WebFetchContinuationIdentity` is the exact current `{engineAgentId,sessionId,runId,toolCallId,target,url}` (without navigation).
- `WebFetchContinuationPage` carries original URL, final URL, status, content type, robots tag and the complete body.
- `servedHtmlPath` produces `.rerun/pages/<base>-<full URL hash>.served-<invocation hash>.html.txt`; metadata uses the corresponding `.meta.txt`.
- `saveWebFetchContinuation` publishes full body plus `views.served` metadata. It returns a path only for a validated `saved` receipt containing the exact served artifact. Unknown/refused/unavailable/invalid outcomes and post-receipt Stop return no path.
- `webFetchContinuationNote` preserves the previous no-copy result when unbound, adds `Saved whole` only for a confirmed path, and otherwise distinguishes an unconfirmed save from successful page retrieval.
- `desktopWebFetchContinuationPublisher` uses bounded authenticated loopback POST `operation:'publish-web-fetch'`; no listener, credential invention, hub-rendered fetch or download tool is added.
- The continuation is best-effort, matching the original: a write failure does not turn a valid page read into a fabricated failure. It also never turns an uncertain write into a saved success or automatically retries it.

## Required root/integration fragments

Apply the served-artifact type/validation fragments before the tool mount. The new module intentionally does not compile against a central union that still excludes `served-html`.

### 1. Add the served artifact kind

In `apps/engine/src/desktop/isolated-screen/types.ts`:

```ts
kind: 'rendered-html' | 'served-html' | 'screenshot' | 'page-metadata'
```

In `apps/engine/src/desktop/isolated-screen/transport.ts`, include `'served-html'` in both `validateScreenExportManifest` and `validatedArtifacts` kind allowlists. Its byte cap is `EXPORT_HTML_MAX`, with `mediaType:'text/plain'`, UTF-8/no-NUL validation and the existing SHA-256 check.

In `apps/ui/lib/desktop/server/browser-exports/binding.ts` `artifactSchema`, add `'served-html'` to the kind enum.

### 2. Accept served paths without weakening confinement

In `apps/engine/src/desktop/isolated-screen/exports.ts` `exportPath`, keep the existing `.rerun/pages` root, segment, length and no-dot/backslash/control checks, and accept only the additional deterministic served forms:

```text
.served-<32 lowercase hex>.html.txt
.served-<32 lowercase hex>.meta.txt
```

The current browser forms remain valid. A concise implementation is to replace the cache filename regular expression with:

```ts
new RegExp(`\\.(?:browser|served)-[a-f0-9]{32}\\.${kind === 'page-metadata' ? 'meta' : 'html'}\\.txt$`)
```

No visible/arbitrary path, user overwrite, `.html` active document or broader hidden-file read is enabled.

### 3. Save before truncation in the existing fetch

In `apps/engine/src/desktop/web-fetch/index.ts`, import:

```ts
import {
  saveWebFetchContinuation,
  webFetchContinuationNote,
  WEB_FETCH_CONTINUATION_DESCRIPTION,
  type WebFetchContinuationIdentity,
  type WebFetchContinuationPublisher,
} from './web-fetch-continuation/index.js'
```

Add the optional context port:

```ts
continuation?: {
  identity: WebFetchContinuationIdentity
  publish: WebFetchContinuationPublisher
}
```

After the existing parse/read/facts/body processing and the `deadline.signal.throwIfAborted()` check, call:

```ts
const saved = context.continuation
  ? await saveWebFetchContinuation({
      identity: context.continuation.identity,
      page: {
        url,
        finalUrl: page.url,
        status: page.status,
        contentType: page.contentType,
        xRobotsTag: page.xRobotsTag,
        body: page.body,
      },
      publish: context.continuation.publish,
    }, deadline.signal)
  : null
```

Replace only the final truncation suffix with `webFetchContinuationNote(truncated, saved)`. Keep status/failure/bytes/finalUrl fields and all error behavior. Use `WEB_FETCH_CONTINUATION_DESCRIPTION` instead of the stale `Read-only; no saved file` description. With no continuation bound, the old text and behavior remain.

### 4. Bind the exact invocation in `desktop/web-fetch-tool.ts`

Import `desktopWebFetchContinuationPublisher` and `isolatedScreenOwner`. Build the optional port only when `ctx.runId` and `options.toolCallId` are present and the current launch owner can be read:

```ts
const continuation = (() => {
  if (!ctx.runId || !options.toolCallId) return undefined
  try {
    return {
      identity: {
        engineAgentId: ctx.agent.id,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        toolCallId: options.toolCallId,
        target: {
          engineAgentId: ctx.agent.id,
          launchNonce: isolatedScreenOwner(ctx.agent.id).launchNonce,
          sessionGeneration: ctx.runId,
        },
        url: webFetchInputSchema.parse(input).url,
      },
      publish: desktopWebFetchContinuationPublisher,
    }
  } catch {
    return undefined
  }
})()
```

Pass `continuation` into `executeWebFetch` alongside `coworkerId`, `signal` and `assertPermission`. Failure to bind the optional save authority leaves the fetch available and unacknowledged; it is not a saved copy and not a fake-success port.

### 5. Web-fetch publication authority

In `apps/ui/lib/desktop/server/browser-exports/service.ts`, add factory options `{ webFetch?: boolean }`. Keep the existing browser authorization as default. In the non-reading branch, first require `call.target.launchNonce === runtime.launchNonce`, then use this web-fetch branch instead of the browser/computer/status checks:

```ts
if (options.webFetch) {
  if (!grants.webFetch || !grants.privateFileWrite) throw denied()
  const service = await getDesktopRemoteMcpService(runtime)
  if (await service.authorizeRun(call, signal, 'privateFileWrite') !== ownerId) throw denied()
} else {
  // Existing browser/computer/privateFileWrite/screen-generation checks unchanged.
}
```

The exact current coworker/session/run, workspace identity, current enabled/deleting checks and post-authority rechecks remain mandatory. `webFetch` permits the read; `privateFileWrite` permits the internal save. No browser, Docker or active-screen requirement is introduced for this operation.

In `receipts.claim`, import `servedHtmlPath` and derive the expected HTML from the served invocation when any file is `served-html`; metadata uses the same path with `.html.txt` replaced by `.meta.txt`. Keep screenshot and browser-rendered expectations unchanged:

```ts
const savedHtml = files.some(file => file.kind === 'served-html')
  ? servedHtmlPath(source.url, source)
  : browserHtmlPath(source.url, source)
const expected = (kind: string) => kind === 'screenshot'
  ? source.navigation?.screenshotPath
  : kind === 'page-metadata'
    ? savedHtml.replace(/\.html\.txt$/, '.meta.txt')
    : savedHtml
```

### 6. Dedicated HTTP operation and service mode

In `apps/ui/lib/desktop/server/browser-exports/binding.ts`:

- Add `'publish-web-fetch'` to `bodySchema.operation`.
- Key the service cache by `${runtime.dataRoot}:${mode}` where `mode = body.operation === 'publish-web-fetch' ? 'web_fetch' : 'browser'`.
- Construct web-fetch entries with `createDesktopBrowserExports(runtime, db, { webFetch: true })`; ordinary browser entries use the current options/default.
- Route `publish-web-fetch` through the same artifact parsing and `entry.service.publish` path as `publish`.

`read` and `read-file` retain their existing workspace-read authorization and exact receipt/file checks. No schema migration is required: existing operation and per-file receipt tables are reused.

## Authored but unrun regressions

| Source | Expected coverage when root executes it |
|---|---|
| `continuation.test.ts` | Inert deterministic served paths; query/invocation collision separation; exact full body, `views.served`, robots/status/content-type/hash/byte metadata; saved receipt path; unknown/refused/unavailable never acknowledged; Stop after committed publication is not acknowledged as success. |
| `result.test.ts` | Previous no-copy output when unbound; confirmed `Saved whole`; truncated output with an explicit unconfirmed save reason. |
| `client.test.ts` | Exact `publish-web-fetch` operation, launch/session/run/tool identity, loopback URL, existing bearer boundary, served artifact bytes and saved-result validation. |

Root additionally needs served union/path/authority regressions, webFetch+privateFileWrite denial, exact-run/session revocation, human/browser operation isolation, concurrent invocation collision, Files readback, and packaged module resolution. No regression was executed here.

## READY vs gated / WAITING

| Area | Status |
|---|---|
| Full served-body continuation, metadata, path and result helpers | **READY in owned source, unrun** |
| Dedicated loopback publisher adapter | **READY in owned source, unrun** |
| Existing public URL admission, redirects, body cap and read behavior | **Preserved; not re-ported** |
| Served type union, path validation and UI artifact schema | **GATED on root fragments 1–2** |
| Exact web-fetch/private-file authority and receipt path acceptance | **GATED on root fragment 5** |
| Existing `web_fetch` continuation mount | **GATED on root fragments 3–4** |
| Dedicated operation/service mode activation | **GATED on root fragment 6** |
| Tests/typechecks/builds/live provider/live DB/native/restart acceptance | **WAITING on root; nothing executed here** |
| Hub-rendered fallback, new download tool, listener or public host | **Unsupported/out of scope** |
| Duplicate grants/credential inheritance policy | **Unchanged root/user decision** |
| New grant IDs, migration, contract barrel or second store | **Not required** |

## Risks and limitations

- The central fragments are deliberately unapplied here. Until they land together, `served-html` is not a valid central artifact and publication must remain unavailable.
- Saving occurs on every eligible read, like the original, not only when text truncates. The continuation is most visible for truncated results, but the durable full copy is the general continuation mechanism.
- A confirmed path is receipt-bound and can be read only through the existing exact-receipt Files path. Ordinary hidden-file policy is not widened.
- Saved HTML and metadata are inert text, not sanitized facts or instructions. Retention and ownership checks do not make the content trustworthy.
- No rendered/browser fallback, second fetch, public listener, new grant or account is provided. Source delivery is not integration or Mac acceptance.
