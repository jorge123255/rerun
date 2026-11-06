# Round 35 H — Rerun documentation help inside Foreman

Base: `5c0f589b51a8129d097f2b97fc420a8acf859b51`.

Source handoff only. Root owns integration, repairs, every execution check, provider dispatch, public-network acceptance, and native/restart QA. No check was executed in this lane; this is not Mac acceptance.

## Original source and design mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/lib/foreman/search-docs.ts`: approved `https://docs.rerun.build/llms-full.txt` corpus, one-hour TTL, 10-second timeout, Mintlify `# Title` / `Source:` page parsing, `##` sections and anchors, original stop words and ranking, four passages, at most two per page, 1,600 characters per passage, original empty/offline notes.
- `apps/ui/lib/foreman/search-docs.test.ts`: original parsing, citation, ranking, no-match and two-per-page expectations.
- `apps/ui/lib/foreman/tool-defs.ts`: original `search_docs` name, query schema and full description. The description is preserved in `FOREMAN_SEARCH_DOCS_DESCRIPTION`.
- `apps/ui/lib/foreman/tools.ts`: the tool executes only inside a live Foreman turn and records its returned result; documentation is not a renderer-initiated effect.
- `apps/ui/lib/site.ts`: `docsUrl()` is exactly `https://docs.rerun.build`.
- `apps/ui/components/chat/ToolCallBlock.tsx`: original collapsed tool-step with query input and output details.
- `apps/ui/components/chat/MessageView.tsx` and `components/ai-elements/sources.tsx`: original collapsible Sources presentation and keyboard-accessible external links.

Current base sources:

- `apps/engine/src/desktop/foreman/binding.ts`: exact enabled/open/running managed Foreman admission and current-run checks around tool effects. The owned engine adapter accepts the same binding and check.
- `apps/engine/src/desktop/foreman/bridge.ts`: authenticated loopback callback, launch nonce, bounded request/response, redirect/error and cancellation pattern.
- `apps/ui/app/api/desktop/internal/foreman/route.ts`: existing engine authentication and exact `app.isLive(binding)` authority.
- `apps/ui/lib/desktop/server/workspace-logo-fetch.ts` and `apps/engine/src/desktop/web-fetch/*`: existing public DNS/IP, TLS, redirect, byte and cancellation confinement reused by the owned fetch adapter.
- `apps/ui/components/desktop/DesktopAssistantReply.tsx`: Mac HTTPS-only external navigation policy; owned Source links use `target="_blank"` and `rel="noopener noreferrer"`.
- `apps/ui/lib/desktop/foreman-client/runtime-client.ts`: current transcript projection keeps visible text only. Root must retain only `search_docs` parts for the owned presentation; no shared projector was changed here.

The local adaptation adds bounded durable cache/receipts, exact corpus fingerprints, stale-cache metadata, same-call recovery and citation-origin validation. It does not create a parallel Foreman authority or a new model/provider path.

Dependent contract revision: `DESKTOP_FOREMAN_CONTRACT_VERSION = 1` in `packages/contracts/src/desktop-foreman.ts` at the exact assignment base. No other agent's unaccepted contract or source is required.

## Implementation inventory

### Contract

`packages/contracts/src/desktop-foreman-docs.ts` exports:

- `DESKTOP_FOREMAN_DOCS_CONTRACT_VERSION = 1` and `DESKTOP_FOREMAN_DOCS_LIMITS`.
- `RERUN_PUBLIC_DOCS_CORPUS`: the only production corpus identity.
- `desktopForemanDocsCorpusSchema`, request/internal-request/query schemas.
- Passage/page/source/result/receipt schemas and their types.
- `isDesktopForemanDocsCitation`: HTTPS, exact `docs.rerun.build` host, no credentials or custom port.
- Original `FOREMAN_SEARCH_DOCS_DESCRIPTION`.

Result shape:

```ts
{
    status: 'ok' | 'empty' | 'unavailable' | 'cancelled'
    documentation: string
    passages: { title: string; url: string; text: string }[] // maximum four
    pages?: { title: string; url: string }[] // empty results, maximum 100
    note?: string
    source: null | {
        corpusId: string
        sourceUrl: string
        cacheState: 'fresh' | 'revalidated' | 'stale'
        fetchedAt: string
        ageMs: number
        sha256: string
        byteLength: number
        version: string
    }
}
```

### Engine adapters

- `apps/engine/src/desktop/foreman-docs/tools.ts`: `desktopForemanDocsTools` offers `search_docs` only with an exact binding and non-null authorized search adapter. It calls `assertCurrent` before and after the request and forwards binding, tool-call ID, query, corpus and abort signal.
- `apps/engine/src/desktop/foreman-docs/bridge.ts`: `createDesktopForemanDocsBridge(runtime, network?)` implements authenticated loopback-only `/api/desktop/internal/foreman-docs`, launch nonce, 16 KiB request, 128 KiB response, 15-second outer bound, no credentials, no redirects and schema-validated results. `close()` aborts owned requests.

### UI server adapters

- `search.ts`: original parser/ranker adapted only to reject foreign citation origins.
- `fetch.ts`: exact allowlisted Mintlify export; existing public DNS/IP and bounded text transport; TLS identity pinned to the original host; every redirect revalidated to the same approved URL; three redirects maximum; no cookie jar, proxy, ambient login or arbitrary URL input.
- `identity.ts`: SHA-256 request, corpus and body fingerprints.
- `store.ts`: concrete libSQL store, `desktopForemanDocsSchemaSql`, `ensureDesktopForemanDocsSchema(db)` and `desktopForemanDocsStore(db)`. Receipt IDs are tool-call IDs bound to full owner/chat/run/query/corpus fingerprints. Cache publication compares the previously read corpus fingerprint and records its publishing owner/run/tool call.
- `service.ts`: live-run checks, fresh/revalidated/stale search, offline behavior, bounded passages/pages, one-hour TTL, 10-second fetch deadline, same-ID result recovery, concurrent-flight joining, orphaned-pending interruption, cancellation and compare-and-swap publication. No startup, mount, history or restart method starts a fetch.
- `binding.ts`: concrete `desktopForemanDocs(runtime)` singleton per data root/launch/engine, using the existing `desktopForeman(runtime).isLive` and database. Missing current authority fails closed with `DesktopForemanDocsLiveError`.
- `api.ts`: `handleDesktopForemanDocs` authenticates the engine, checks launch nonce, bounds JSON, calls the exact service with the request abort signal and returns no-store safe responses.

### Presentation

`apps/ui/components/desktop/foreman/docs/DesktopForemanDocsTool.tsx` exports:

- `desktopForemanDocsOutput(output)`: validates object or JSON-string receipts; malformed/foreign output falls back to the existing generic tool step.
- `DesktopForemanDocsTool`: original collapsible tool-step query plus owned Sources result.
- `DesktopForemanDocsResult`: passages or empty-result page links, notes, cache state, fetch timestamp and version. It has no effect, fetch, timer, model request, settings mutation or permission action. Sources use native keyboard-accessible collapsibles and external links.

## Required root integration

No fragment below was applied to a shared file in this lane.

### 1. Contract barrel

Add to `packages/contracts/src/index.ts`:

```ts
export * from './desktop-foreman-docs.js'
```

### 2. Additive desktop schema initialization

Add to the imports in `apps/ui/lib/desktop/server/database.ts`:

```ts
import { ensureDesktopForemanDocsSchema } from './foreman-docs/store'
```

Call after the existing feature initializers in `initialize(dataRoot)`:

```ts
await ensureDesktopForemanDocsSchema(client)
```

This creates only `desktop_foreman_docs_corpus`, `desktop_foreman_docs_receipts` and their run index. Existing migrations and tables are unchanged.

### 3. Internal route

Create root-owned `apps/ui/app/api/desktop/internal/foreman-docs/route.ts`:

```ts
export { handleDesktopForemanDocs as POST } from '@/lib/desktop/server/foreman-docs/api'
export const runtime = 'nodejs'
```

### 4. Exact live-run engine binding

In `apps/engine/src/desktop/foreman/binding.ts`, add:

```ts
import { RERUN_PUBLIC_DOCS_CORPUS } from '@rerun/contracts'
import { createDesktopForemanDocsBridge } from './foreman-docs/bridge.js'
import { desktopForemanDocsTools } from './foreman-docs/tools.js'

type DocsBinding = ReturnType<typeof createDesktopForemanDocsBridge>
let installedDocs: DocsBinding | undefined
```

Replace `bindDesktopForeman` with the additive lifecycle below:

```ts
export function bindDesktopForeman(runtime: ForemanRuntime, network?: typeof fetch) {
    installed?.close()
    installedDocs?.close()
    const binding = createDesktopForemanBridge(runtime, network)
    const docs = createDesktopForemanDocsBridge(runtime, network)
    installed = binding
    installedDocs = docs
    return {
        bridge: binding,
        close() {
            binding.close()
            docs.close()
            if (installed === binding) installed = undefined
            if (installedDocs === docs) installedDocs = undefined
        },
    }
}
```

After the existing `foremanTools(...)` construction in `desktopForemanTools(ctx)`, add the owned tool and preserve the existing current check:

```ts
const docs = installedDocs
Object.assign(tools, desktopForemanDocsTools({
    binding,
    corpus: RERUN_PUBLIC_DOCS_CORPUS,
    assertCurrent: current,
    search: docs ? (input, requestSignal) => docs.search(input, requestSignal ?? signal) : null,
}))
```

`installedDocs` belongs to the same app launch as `runtime`; `current()` still rejects a replaced launch, closed session, finished run or changed model. Stop travels through `ctx.abortSignal` and the owned bridge. No historical call has a running binding.

### 5. Original documentation instruction

Append to the existing instruction lines assembled in `apps/ui/lib/desktop/server/foreman/binding.ts`:

```ts
'A question about Rerun itself, how something works, what it costs, what a plan or the API allows, is answered out of the documentation: call search_docs and give the user the link of the passage used. Never answer one of those from memory, and never invent a feature, a limit or a price. If search_docs is empty or unavailable, preserve its honest state rather than guessing.'
```

This is prompt guidance only; admission remains enforced by the tool factory and current-run checks.

### 6. Retain only documentation parts in the Foreman transcript

In `apps/ui/lib/desktop/foreman-client/runtime-client.ts`, add `type UIMessage` from `ai` and use this projection:

```ts
function documentationParts(parts: unknown[]): UIMessage['parts'] {
    return parts.filter((part): part is UIMessage['parts'][number] => {
        if (!part || typeof part !== 'object') return false
        const value = part as { type?: unknown; toolName?: unknown }
        return value.type === 'tool-search_docs' || value.type === 'dynamic-tool' && value.toolName === 'search_docs'
    })
}

export function desktopForemanMessages(state: DesktopForemanClientState) {
    return state.messages.map(message => ({
        id: message.id,
        role: message.role,
        text: visibleText(message.parts, '\n'),
        parts: documentationParts(message.parts),
    })).filter(message => message.text.length > 0 || message.parts.length > 0)
}
```

Do not retain unrelated context/tool parts. This projection performs no request.

### 7. Mount the pure result renderer

In `DesktopForemanChatLayer.tsx`, add:

```tsx
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai'
import { DesktopForemanDocsTool } from './docs/DesktopForemanDocsTool'
```

Extend the existing message type without changing text behavior:

```ts
export type DesktopForemanMessage = {
    id: string
    role: 'user' | 'assistant' | 'system'
    text: string
    parts?: UIMessage['parts']
}
```

Inside the existing message bubble, immediately after `{message.text}`, render only retained documentation parts:

```tsx
{message.parts?.map((part, index) => {
    const toolCallId = 'toolCallId' in part && typeof part.toolCallId === 'string' ? part.toolCallId : `${message.id}-docs-${index}`
    return <DesktopForemanDocsTool key={toolCallId} part={part as ToolUIPart | DynamicToolUIPart} restored={message.id.startsWith('engine-')} />
})}
```

Opening Foreman, polling existing state, reopening history and clicking a citation do not invoke the service. Board, composer draft, selected model, settings and permissions remain unchanged.

## Persistence, cancellation and recovery semantics

- A completed tool-call receipt returns its original result without another fetch. Reusing the ID with changed owner/run/query/corpus refuses.
- Concurrent identical calls join the in-memory flight. An orphaned pending receipt becomes an honest interrupted result on explicit same-ID recovery; it never triggers a new fetch.
- Cancellation aborts DNS, connect, body read and response consumption. A cancelled receipt is persisted best-effort; if that write cannot finish, orphaned-pending recovery still prevents automatic re-execution. Retry requires a new tool-call ID.
- Live authority is checked before reservation, around fetch/redirects, before and after cache publication, and around result completion. Late or replaced-run completions do not publish a result.
- Cache is public documentation only, never workspace content or credentials. Raw corpus is capped at 1,000,000 bytes. A changed corpus identity cannot reuse the previous identity's cache.
- Cache survives restart and origin changes through the existing desktop database. Fresh means less than one hour old. Offline revalidation failure may use a valid stale corpus with its actual age/version and an explicit stale note; without a valid cache the original documentation-home/unavailable guidance is returned.
- Startup, application mount, state reads, transcript projection, history rendering and restart perform no fetch, model request or receipt recovery effect.
- Stored passages and links are untrusted documentation data, not instructions. Foreign citation origins and malformed receipts are not rendered as trusted help.

## Authored but unrun regression sources

- `apps/engine/src/desktop/foreman-docs/contract.test.ts`: original limits, exact identity, bounded query, passage caps and foreign-citation refusal.
- `apps/engine/src/desktop/foreman-docs/tools.test.ts`: missing binding/adapter, exact forwarded identity, current-run checks and stale completion refusal.
- `apps/engine/src/desktop/foreman-docs/bridge.test.ts`: authenticated loopback request, exact body, bounded adapter and invalid callback authority.
- `apps/ui/lib/desktop/server/foreman-docs/search.test.ts`: original page/heading parsing, anchors, ranking, no matches and two-per-page behavior.
- `apps/ui/lib/desktop/server/foreman-docs/fetch.test.ts`: exact export allowlist and unsafe redirect/origin refusal.
- `apps/ui/lib/desktop/server/foreman-docs/service.test.ts`: result/source limits, fresh cache, honest empty, stale offline, unavailable without cache, duplicate/conflicting IDs, oversized documents, changed corpus identity, Stop and cancelled same-ID recovery.
- `apps/ui/components/desktop/foreman/docs/DesktopForemanDocsTool.test.tsx`: saved citation/metadata rendering, keyboard-compatible external-link attributes, no fetch on history, and foreign-output refusal.

No tests, typecheck, lint, builds, installs, servers, Docker, provider/API/network calls, browser/native UI, microphone, Keychain or restart checks were run. No public corpus was fetched in this lane.

## Supported / dependent / unsupported matrix

| Area | Owned implementation | Root dependency or unsupported remainder |
| --- | --- | --- |
| Original parsing/ranking/defaults | Implemented | Execute regression sources |
| Approved public fetch | Implemented | Route mount and real offline/redirect/timeout QA |
| Durable corpus and receipts | Implemented | Contract export and schema initialization |
| Exact live managed-run tool | Implemented | Engine lifecycle/binding fragment and provider QA |
| Empty/offline/stale states | Implemented | Network and restart acceptance |
| Sources/help presentation | Implemented | Transcript projection/mount and keyboard/native QA |
| Same-ID recovery and Stop | Implemented | Cancellation/restart acceptance |
| Arbitrary URL/page fetch | Unsupported | Must remain unsupported |
| Authenticated browsing, hosted token, paid search | Unsupported | Must remain unsupported |
| Automatic fetch on mount/history/restart | Explicitly absent | Must remain absent |
| Settings, model, draft or permission mutation | Explicitly absent | Must remain absent |
| Mac acceptance | Not run | Root performs all checks and repairs |

## Known limits

- Search covers the approved Mintlify export only; it does not follow passage links to fetch full pages.
- Empty-result page lists cap at 100 to bound output; passage defaults remain four total, two per page and 1,600 characters.
- Cached documentation can be stale and is labelled with its actual fetch timestamp and age. The tool does not claim current hosted account state or pricing beyond the retrieved corpus.
- An interrupted pending receipt requires explicit new input; it is not resumed automatically.
- No Next.js dependency documentation was present under the prepared worktree's `node_modules`; the route follows the current base's existing authenticated internal-route idiom.
