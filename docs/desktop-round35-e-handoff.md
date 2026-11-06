# Round 35 E — Company Brain semantic search

Source handoff only. Root integration, provider execution, migration and native acceptance remain pending. This is not Mac acceptance.

## Original source/design mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/engine/src/brain/search.ts` — vector + full-text reciprocal-rank fusion, two passages per page and one-hop related pages.
- `apps/engine/src/brain/embedding.ts` — bounded background embedding, hash guards and keyword availability while the hub is down.
- `apps/engine/src/brain/chunks.ts` — section merging/splitting, title/type/heading embedded text and content hashes.
- `apps/engine/src/brain/maintenance.ts` — disk-authoritative edit/delete/restore reconciliation.
- Current `apps/engine/src/desktop/brain-tools.ts` — existing keyword-only tool, citations and grant.
- Current `apps/engine/src/desktop/brain-pages.ts` — Markdown authority, hash-checked reads and keyword ranking.
- Current desktop semantic-memory index/cosine/vector validation and UI auxiliary embedding backend/credential custody.

The actual gap was vector indexing/search, not another content store or provider. This lane adds a derived local chunk index keyed by workspace/page slug, page hash, chunk text hash and provider identity, while preserving the existing Markdown/Brain page authority and citations.

## Implementation inventory

`packages/contracts/src/desktop-brain-semantic.ts` exports canonical backend/page/chunk/index-entry/pending/status/search types and ports:

- `DesktopBrainSemanticBackend` — model/version/dimensions/credential revision.
- `DesktopBrainSemanticPage` and `DesktopBrainSemanticChunk` — current authoritative content and original `chunkPage` identities.
- `DesktopBrainSemanticIndexEntry` and `DesktopBrainSemanticPending` — page hash, provider fingerprint, vector and retry state.
- `DesktopBrainSemanticIndexStatus` — `ready`, `partial`, `keyword-only`, `unavailable`, `invalid`, indexed/pending/omitted counts and honest message.
- `DesktopBrainSemanticSearchResult` — original hits/passages/related pages plus index state.
- `DesktopBrainSemanticPages`, `DesktopBrainSemanticEmbedding`, `DesktopBrainSemanticIndexStore`, `DesktopBrainSemanticAuthority` and `DesktopBrainSemanticPorts`.

`apps/engine/src/desktop/brain-semantic/service.ts` implements:

- Reconciliation from current pages using original `chunkPage`; stale/deleted page and pending removal.
- Bounded batches of 16 with at most three attempts per chunk. Every vector write rechecks the current page hash and backend/dimensions. Page changes during embedding leave pending work rather than stale evidence.
- Explicit `reconcile(embed)` for maintenance versus `reconcile(false)` bookkeeping with no provider call. `invalidate(slug, expectedHash)` refuses changed pages and removes derived entries/pending.
- Original reciprocal-rank fusion of semantic and keyword results, two passages per page and linked pages. Deleted/stale pages are filtered again during search.
- Honest keyword fallback when no service, offline service or incomplete indexing. No fabricated semantic relevance or unrelated padding.

`tool.ts` preserves the existing Brain grant and original `[[slug]]`, title/type, heading/excerpt, unconfirmed and linked-page output, adding an explicit `Search mode` and indexing message. `brain_read` and `brain_propose` remain root-owned.

UI server `service.ts` concretely binds `getDesktopBrainStore`, `desktopAuxiliaryBackends`, `desktopAuxiliaryStore` and `desktopBrainSemanticStore`. `store.ts` persists only derived entries and pending work in `desktop_brain_semantic_chunks` and `desktop_brain_semantic_pending`.

## Additive migration and root mounts

Add `desktopBrainSemanticSchema` from `apps/ui/lib/desktop/server/brain-semantic/schema.ts` through central migration/bootstrap. This is additive derived state; no page, memory or credential table changes are required.

Mount only the new `brain_search` implementation while preserving the existing `brain_read` and `brain_propose` registrations:

```ts
import { desktopBrainSemanticTools } from '../desktop/brain-semantic/tool.js'
import { createDesktopBrainSemanticServer } from '@/lib/desktop/server/brain-semantic/service'

const semantic = createDesktopBrainSemanticServer(runtime, currentBrainAuthority)
Object.assign(tools, desktopBrainSemanticTools(ctx, await semantic.ports()))
```

`createDesktopBrainSemanticServer(runtime, authority)` returns `{ports,reconcile,search,status,invalidate}` and internally constructs the ports shown in `service.ts`. Root should pass the same enabled/not-deleting/current-run Brain authority used by existing Brain tools.

After accepted page save/delete/restore, call `invalidate(slug, expectedHash)` with the newly committed page hash. A changed hash refuses publication. `reconcile(false)` is safe for restart bookkeeping and performs no provider call. `reconcile(true)` belongs only to root’s explicit embedding maintenance path, never to mount/history/status reads.

Settings/status uses `status()` and reports `backend`, `indexed`, `pending`, `omitted`, `mode`, and message. It does not spawn, authenticate or embed on mount. Existing auxiliary credential configuration is used unchanged; no provider onboarding or fallback provider is added.

## Persistence and recovery semantics

- Current Markdown pages remain authoritative. Derived entries are only projections of chunk text/hash/provider identity.
- Restart may reconcile bookkeeping and remove stale work but must not automatically call the provider. Pending work resumes only through explicit maintenance.
- Offline embedding keeps keyword results and labels the index partial/unavailable rather than ready. Provider/model/revision changes exclude old vectors from semantic ranking.
- Searches re-read page state and filter stale/deleted pages again. Empty results are not replaced with unrelated text.
- Keyword hits and semantic hits fuse by rank, never by an invented confidence percentage or acceptance decision.
- Private coworker memories and Brain pages remain separate. Search adds no write, proposal acceptance, arbitrary-file access or new grant.

## Supported / dependent / unsupported matrix

| Area | Status | Dependency or unsupported scope |
| --- | --- | --- |
| Original chunking and page/citation identity | Implemented in source | Existing Markdown/Brain authority unchanged |
| Derived index and pending persistence | Implemented in source | Root supplies additive migration |
| Semantic ranking with RRF and keyword fallback | Implemented in source | Root supplies current auxiliary embedding backend |
| Edit/delete/restore hash invalidation | Implemented in source | Root calls invalidate after accepted mutations |
| Restart without automatic provider calls | Implemented in source | Root controls explicit embedding maintenance |
| Search tool and status output | Implemented in source | Root mounts registry and Settings status |
| Provider onboarding or second provider | Unsupported | Existing auxiliary configuration only |
| Second editable content store or private-memory sharing | Unsupported | Derived projection only; pages and memories stay separate |
| Write/proposal acceptance/arbitrary-file access | Unsupported | Search is read-only |
| Live provider/native/restart acceptance | Root dependent | No execution was performed here |

## Authored, unexecuted regressions

- `service.test.ts`: semantic-only matches, offline keyword fallback, page hash races during embedding, deleted/restored pages, provider changes and workspace isolation.
- `store.test.ts`: derived entry/pending persistence, exact identity removal and page-scoped cleanup.
- `tool.test.ts`: empty-result/index-mode distinction and existing Brain grant refusal.

No tests, typecheck, lint, builds, installs, servers, Docker, provider calls, browser/native UI, microphone, Keychain or restart checks were executed. The installed Next.js documentation directory was absent. Root runs every check and repair. No checklist completion or installed acceptance is claimed.

## Root review repair implementation

The handoff had parse errors, missing chunk slugs, a nonexistent UI page-store import, asynchronous credential misuse, unstable pending IDs, read-time DDL and missing cancellation guards. The repaired implementation keeps canonical pages and the derived index in the engine. `initializeDesktopBrainSemanticStore` adds its schema to the existing Brain DB once in datadir migration 6. Reads never execute DDL. Chunk IDs bind page hash, slug, ordinal, text hash and backend revision; pending retry counts survive reconciliation.

Concrete engine runtime uses `getDesktopBrainStore` and the existing authenticated `/api/desktop/internal/semantic-memory` configuration/embed callback. Credentials stay in the existing encrypted app auxiliary store. `brain_search` is mounted in the desktop registry over the previous keyword-only search, retaining `brain_read` and `brain_propose`. Current Brain grant/deletion checks and caller Stop surround all result publication; late ignored embedding responses cannot write vectors.

Engine routes under `/desktop/brain/semantic/:engineAgentId`: GET `status`, POST `search` `{query,limit}`, POST `index` `{embed:boolean}`. A maintenance request embeds at most 16 pending chunks; later explicit requests advance the remaining queue. Status/restart/search do not automatically index page batches. Search embeds only the explicit query when current indexed passages exist, merges keyword ranking, rechecks current passage content and returns both outgoing and incoming one-hop links.

UI `createDesktopBrainSemanticServer(runtime, authority)` now proxies these authenticated engine routes. Its methods are `status(engineId,signal)`, `reconcile(engineId,embed,signal)` and `search(engineId,query,limit,signal)`. The old app-SQL index store is no longer the production authority; its pure store regressions initialize their schema explicitly. No E app-database migration is required.

Additional authored regressions cover pending identity/retry retention, changed/deleted pages, backend rotation, offline keyword fallback, backlinks and ignored Stop responses. All remain unexecuted by this helper. Root owns checks and native acceptance.
