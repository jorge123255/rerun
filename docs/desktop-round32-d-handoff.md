# Round 32 D — Rerun `web_search`

Source handoff only. Backend activation, integration checks and E2/native acceptance remain root dependencies.

## Original-to-Mac mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/engine/src/tools/builtin/web.ts` — default 5, maximum 20, 15-second search intent, ranked title/URL/snippet, `No results.` and `Search failed:`. The original hub transport is deliberately not copied.
- `apps/engine/src/tools/builtin/web.test.ts`, `web.hub.test.ts`, `web.gaps.test.ts` — original formatting, missing-capability, empty-result and failure boundaries.
- `apps/ui/components/chat/ToolCallBlock.tsx`, `StepRow.tsx`, `MessageView.tsx` — established activity, input/output and error presentation reused by the adapters.
- Current `apps/engine/src/desktop/web-fetch-tool.ts`, `web-fetch/**`, `packages/contracts/src/desktop-tool-grants.ts` and provider bridges — independent Rerun/native grants, owner/run cancellation and public URL policy.

The Mac description removes paid-data guidance. `No results.` is returned only for an acknowledged successful empty provider response. Cancellation throws from the tool instead of becoming a search failure or empty result.

## Exported contract and ports

`packages/contracts/src/desktop-web-search.ts` exports:

- `desktopWebSearchInputSchema` and `desktopWebSearchInputOf` — strict query, normalized whitespace, default 5 and positive integer maximum 20.
- `desktopWebSearchResponseSchema` — strict provider order, title/URL/snippet/provenance validation, 20-result and 65,536-byte aggregate limits. Query/title/snippet/URL limits are 512/512/4,000/8,192 characters.
- `desktopWebSearchOutcomeSchema` — `success`, `unavailable`, `error`, `cancelled`, `uncertain`, with explicit provider provenance only for real results.
- `desktopWebSearchCapabilityViewSchema` — secret-free `ready`, `unconfigured`, `unavailable`, message and retryable state.
- `DesktopWebSearchAdapter`, `DesktopWebSearchAuthority`, `DesktopWebSearchReadinessProjection`, `DesktopWebSearchOutcomeStore`, `DesktopWebSearchPorts`.
- `desktopWebSearchFingerprint` — SHA-256 over full invocation identity, adapter generation and normalized request; no raw query is used as a storage key.

`apps/engine/src/desktop/web-search/service.ts` exports `createDesktopWebSearchService(ports, {deadlineMs})` with `{search,readiness}`. `web-search-tool.ts` exports `desktopWebSearchTools`, `formatDesktopWebSearchOutcome`, `webSearchDescription` and `webSearchActivity`.

`apps/ui/lib/desktop/web-search.ts` exports activity text, saved-outcome parsing, result views, source metadata and readiness messages. `DesktopWebSearchResults` is an optional original ranked-list renderer for root’s existing tool-detail mount.

## Required root integration

### Contract and independent grant

Add the contract export:

```ts
export * from './desktop-web-search.js'
```

Add `webSearch` to `desktopRerunGrantIds` and a separate Rerun catalog entry for `web_search`. Keep native `desktopCodexGrantIds.webSearch` unchanged. Keep `download` unavailable rather than widening this package. The temporary type assertion in `web-search-tool.ts` can be removed after the grant ID lands.

### Authorized adapter

Supply one approved adapter; do not select a provider from model text or read another credential:

```ts
const adapter: DesktopWebSearchAdapter = {
    generation: approvedConfiguration.revision,
    async search({ query, maxResults, identity, signal }) {
        // Revalidate the current root-owned run, then call the approved backend once.
        return approvedBackend.search({ query, maxResults, identity, signal })
    },
}
```

The adapter must return `{provenance:{provider:'approved-public-provider-id'},results:[{title,url,snippet}]}`, preserve provider order, honor the supplied signal and never include credentials or internal endpoint details in public errors. Root chooses and stores all backend configuration.

`authority(identity,signal)` must check current enabled/not-deleting owner, `webSearch` grant, current session/run/tool-call and cancellation, returning the current `adapterGeneration` before dispatch and before delivery. Registry mount in `apps/engine/src/tools/registry.ts`:

```ts
import { desktopWebSearchTools } from '../desktop/web-search-tool.js'

const tools: ToolSet = {
    // existing desktop spreads, including desktopWebFetchTools(ctx),
    ...desktopWebSearchTools(ctx, desktopWebSearchPorts(ctx)),
}
```

`desktopWebSearchPorts(ctx)` is root-owned composition of the approved adapter, authority, readiness projection and existing durable outcome authority. No new global singleton or provider bridge is supplied by this lane.

### Durable outcome port

Implement `outcomes.begin/complete` over the existing turn/tool outcome authority:

- `begin(identity,fingerprint)` atomically returns `'execute'` or the retained outcome. Conflicting identity reuse refuses. An interrupted in-flight record returns `uncertain`, never permission to execute again.
- `complete(identity,fingerprint,outcome)` persists the exact acknowledged outcome. A saved success is returned with zero new backend calls. An uncertain write must not become a retry.

No parallel chat/run database or persistent raw-query cache is introduced. The fingerprint is the deduplication key; result persistence follows root’s existing tool-output retention contract.

### Activity, history and Settings

- Use `webSearchActivity` or `desktopWebSearchActivityOf(input)` for the established tool row. Existing `DesktopToolStep` can display the original formatted output; optionally mount `DesktopWebSearchResults` for ranked links.
- Parse typed saved outcomes with `desktopWebSearchHistoryOutcome`. History reads and detail expansion never call `search` or `readiness`.
- `desktopWebSearchSourceMetadata` returns provider-backed title/URL/snippet/provenance only for successful outcomes. It does not create assistant citations; root may feed it to the existing citation pipeline only when that pipeline explicitly supports these provider rows.
- Settings/Tools readiness uses `service.readiness(signal)` and `desktopWebSearchCapabilityMessage`. Missing adapter returns `unconfigured`/`unavailable`, never empty success. Closing the panel aborts only that projection read and performs no search, installation or credential prompt.
- Update the desktop tool instruction so an enabled Rerun grant no longer says `web_search` is unavailable. Keep native Codex search wording independent.

## Persistence, cancellation and errors

The complete operation has a 15-second deadline, including authority, adapter work and result validation. Exact in-flight identity/fingerprint calls coalesce. Owner/grant/capability changes cancel or refuse publication. Late adapter completion cannot save after cancellation. Provider-stage errors are redacted to `Search provider failed.`; authority conflicts can retain their safe actionable messages. URLs use the existing public HTTP(S) policy without fetching result pages.

## Feature matrix

| Area | Status | Dependency or unsupported scope |
| --- | --- | --- |
| Canonical input/results/provenance | Implemented in source | Root exports the contract |
| Original formatting and empty/failure behavior | Implemented in source | Root registry mount |
| Authorized backend execution | Root dependent | No adapter, credential, provider or spending choice is included |
| Current owner/run/grant checks | Port implemented | Root supplies authority and `webSearch` grant |
| Deduplication and lost acknowledgement | Implemented in source | Root supplies atomic existing outcome store |
| Restart/history without re-execution | Implemented in source | Root supplies saved outcomes and history mount |
| Activity/readiness/ranked results | Adapters implemented | Root Tools/Settings/detail mounts; visual QA pending |
| Cancellation and late publication | Implemented in source | Root supplies active run signal and adapter cancellation |
| Assistant citations | Not synthesized | Optional provider metadata requires explicit root citation mapping |
| Hosted hub, paid data, downloads, new providers | Unsupported | No hosted activation or arbitrary remote bundle |
| Native Codex web search | Independent and unchanged | Separate existing permission and provider path |
| Full E2/native acceptance | Root dependent | No test/build/live/native check was run here |

## Authored, unexecuted regressions

- `apps/engine/src/desktop/web-search/service.test.ts`: original defaults/order/empty, unavailable adapter, malformed/oversized rows, URL policy, internal-error redaction, deadline, revoked authority, in-flight coalescing, conflict, uncertain acknowledgement, retained restart outcome and late completion.
- `apps/engine/src/desktop/web-search-tool.test.ts`: original formatting, empty/unavailable distinction, description, grant-off, invalid input before effects and cancellation.
- `apps/ui/lib/desktop/web-search.test.ts`: activity, source metadata, saved outcomes, result views and readiness messages.
- `apps/ui/components/desktop/web-search/DesktopWebSearchResults.test.tsx`: provider ranking, links, snippets, empty/error states and no synthesized assistant citation label.

No tests, typecheck, lint, builds, dependency installation, servers, packaging, UI actions, Docker, live providers/APIs, browser searches or Keychain access was performed. The installed Next.js documentation directory was absent from this worktree. Root must run every check and repair any defect; no checklist or acceptance claim is made.
