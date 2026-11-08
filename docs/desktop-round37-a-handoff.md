# Round37 A — custom OpenAI-compatible provider runtime

Implementation SHA: `6ebc50dc94dc437a40f0218e6804acda115e1f7f`. Initial contract publication: `d98fe9ed4758775f291b28f7146a46f8326bf560`; implementation adds the draft-probe operation and strict endpoint validation to that same v1 contract. B must consume the **implementation revision**, not only the initial contract commit. This document is committed separately so its implementation reference is not self-referential.

Branch `desktop/round37-custom-provider-runtime`; initial verified clean base `e87edabffded9b56c67f98539a412e230959435c`. Accepted runtime reference supplied by root is `81f1c62a7b9fb0ac1f44bbee77c21e0f4aa576f5`; this package does not claim that runtime contains these changes.

**Partial source implementation; activation and durable connection mutation are dependent on a missing central secure connection authority.** No checks executed: no tests, fixtures, typecheck, lint, build, installs, servers, network/provider requests, UI, microphone, Docker, Keychain, live credentials/databases or restart QA. No installed acceptance, provider activation, permissions, publication, push or merge. Root reviews, fixes and performs all execution/acceptance. Round36 lanes remain untouched.

## Source mapping

Read updated original fork `2a57fa6dd53311f763bfc9abde85997b7f7e5309` in the supplied read-only upstream-review worktree:

- `packages/contracts/src/custom-provider.ts`: exact eight preset ids/names/URLs/order; optional key; manual-model fallback; 128,000 default context.
- `packages/contracts/src/connection.ts`: baseUrl/contextWindow/vision, discovered-model shape, optional custom key, custom provider semantics, fixed provider identity.
- `apps/engine/src/connections/custom-catalog.ts`: exact model IDs, context_length/max_model_len/context_window/max_context_length, retained last-known catalog, explicit manual one-token probe.
- `apps/engine/src/agents/providers.ts`: `.chat(modelId)` rather than Responses API; optional-key placeholder; custom model branch and reasoning middleware pattern.
- `apps/ui/components/connections/custom/{AddCustomProviderPage,CustomEndpointSettings}.tsx`: preset/name/address/key/manual-model flow, explicit Connect, endpoint/window/vision settings. B owns UI; no substitute UI was authored here.

Mac adaptations: do not rewrite localhost to host.docker.internal; explicit per-connection HTTP/private-destination review replaces cloud/container assumptions. Native Node DNS is resolved and pinned for each connection, redirects refused and credentials omitted when absent. No automatic refresh or probe on restore. Endpoint failures expose fixed local messages instead of upstream body snippets. No use of commercial `ee` code.

Current mounted sources inspected: engine `agents/providers.ts`, `agents/openrouter-reasoning.ts`, `connections/{store,registry,types}.ts`, `runtime/compaction/compact.ts`; UI `DesktopSettings.tsx`, `server/{settings,runtime,auth}.ts`, existing MCP encrypted/network modules and service header codec; native supervisor/runtime secure identity setup. Read CLAUDE, UI AGENTS/CLAUDE, assignment standard and upstream review. Installed Next guide absent in both local node_modules locations; no Next APIs introduced or dependencies installed.

## Inventory and exact public contract

Changed owned source:

1. `packages/contracts/src/desktop-custom-provider.ts`
2. `apps/engine/src/desktop/custom-providers/network.ts`
3. `.../runtime.ts`
4. `.../draft-probe.ts`
5. `.../connection.ts`
6. `.../index.ts`
7. `.../runtime.test.ts`
8. `.../protocol.test.ts`
9. `apps/ui/lib/desktop/server/custom-providers/api.ts`
10. `.../api.test.ts`
11. `.../index.ts`
12. `docs/desktop-round37-a-handoff.md`

Canonical contract version 1 exports `DESKTOP_CUSTOM_PRESETS`, `CUSTOM_DEFAULT_CONTEXT_WINDOW`, identity/config/model/endpoint-policy/snapshot/probe/change/request/receipt schemas and types, plus `CustomProviderAuthority`. No general replacement provider registry.

Identity is `{workspaceId:number,connectionId:string,revision:number}`. Models retain exact ids, nullable context, explicit vision and discovered/manual source. Snapshot carries config, configuredSecret **flag only**, configured/disconnected state and catalog status `never|fresh|stale|unavailable|empty`, last observation/attempt times. `configured` means saved configuration, not verified live inference or accepted setup.

Settings requests are strictly:

```ts
{ action:'probe_draft', requestId, workspaceId, baseUrl, policy, apiKey?, manualModel? }
{ action:'read', identity }
{ action:'probe', identity, manualModel? }
{ action:'change', change:
  | { action:'create', requestId, workspaceId, connectionId, config, apiKey? }
  | { action:'update', requestId, identity, config, apiKey?, clearSecret? }
  | { action:'disconnect', requestId, identity }
}
```

`apiKey` is write-only input to the existing secure authority; never part of a public snapshot/receipt/catalog/error. Config URLs reject embedded credentials/query/fragment. The policy records exact reviewed origin plus independent `allowHttp` and `allowPrivate`; preset selection itself does not grant either flag. Draft probes keep the typed credential ephemeral and never create/save a connection. Manual fallback sends the original fixed one-token request only as part of explicit Probe/Connect, never an ordinary read. A manually usable model does not turn unavailable discovery into a fresh catalog; B may add that exact manual ID to `config.models` with source manual.

### Actual adapters

`createCustomProviderRuntime(authority)` exposes:

- `model(identity, modelId, stop)` -> actual AI SDK LanguageModel plus contextWindow, vision, signal and close.
- `oneShot(identity, modelId, generateTextInputWithoutModel, stop)` -> actual generateText result; closes lease in finally and checks identity after await.
- `stream(identity, modelId, streamTextInputWithoutModel, stop)` -> actual streamText result plus close/contextWindow/vision. Root must close in its run finalizer on success/error/Stop.
- `probe(identity, manualModel?, stop)` -> saved-identity discovery/manual usability result, published only through `authority.recordProbe` with current identity.
- `close()` -> aborts leases and unsubscribes from material connection changes. Root must still drain its actual active run promises before declaring shutdown complete.

`bindRegisteredCustomConnection(authority)` concretely uses existing `connections/registry.ts:getConnection`, verifies exact ID/provider/base URL against the canonical snapshot and rechecks revision around each await. It **never reads LoadedConnection.env**. Credential resolution delegates solely to the supplied secure connection owner. Registry membership cannot prove custody/revision by itself.

`createDesktopCustomProviderApi(authority)` provides `request(runtime, Request)` and `close()`. It accepts only JSON POST (64KB cap), checks current workspace, returns public typed snapshots/receipts and fixed errors, and preserves a committed receipt even if cancellation arrives afterward. It does not implement a new credential or revision store.

`probeCustomDraft(input, checkWorkspace, signal)` is an actual bounded pre-create probe using pinned transport and a workspace-lifetime callback. The UI API binds that callback to existing `readDesktopRuntime` and exact launch nonce/workspace checks. No model-supplied destination enters these adapters.

Network implementation uses Node HTTPS/HTTP with ordinary TLS validation and an exact pinned lookup result. It checks every DNS answer, blocks metadata/link-local/multicast, IPv4-mapped IPv6 and unreviewed private IPs; no redirect, ambient cookies, URL credentials or Docker substitution. Paths are fixed to `/models` and `/chat/completions` under the reviewed base. Requests cap at 2MB, catalog responses 512KB, inference responses 16MB, individual transport deadline 120s, entire probes 30s. DNS awaits are cancellation-raced. Response reader cancels on byte cap, stale identity or Stop; non-2xx provider bodies never propagate to errors. Remote vision URLs remain part of the prompt delivered to a reviewed provider, not host-side fetch destinations.

Inference reuses installed `@ai-sdk/openai` and `ai`, imports the existing `openrouterReasoningMiddleware` (supports both reasoning/reasoning_content in streams and generated responses), and chooses explicit `.chat(modelId)`. No model/provider fallback or OpenAI Responses call. SDK tool execution stays with root's existing tool/grant loop. Context precedence is last-known discovered window, explicit model window, connection window, 128,000. Output requests reaching/exceeding context refuse; actual prompt-token budgeting remains the existing compaction authority, not an invented character/token estimate. Vision is explicit user capability, never guessed from model name.

## Precise missing central authority — no durable-success claim

The inspected existing `connections/store.ts` calls `writeEnvFile(connectionEnvPath(id), input.keys)` and updates keys by reading/writing that plaintext file. The loaded registry has config/env but **no canonical desktop custom connection revision, durable request receipt ledger or encrypted provider credential API**. Existing MCP/service encrypted stores are coworker/installation-scoped and cannot be relabelled as a provider key store. Native `RERUN_DESKTOP_SECRET_KEY` is existing key custody, not itself an encrypted provider connection API.

Consequently `CustomProviderAuthority.change/read/credential/assertCurrent/recordProbe/subscribe` requires root's canonical secure connection binding. This package must NOT be activated with the old `.env` writer or a fake/in-memory implementation. Durable create/update/disconnect/lost-ACK recovery and durable last-known catalog are **not implemented by the current base**. They are explicitly dependent, not hidden behind an assertion that a named port is production functionality.

Root's canonical implementation must meet this exact contract:

1. `read` returns exact owned connection revision and public snapshot; disconnected stays disconnected after restart. Reading never probes or repairs.
2. `credential` opens the connection's current encrypted optional key, scoped to workspace/connection/revision, after live checks. Empty means no Authorization header. Never read old provider .env, another provider's credential or ChatGPT login.
3. `change` retains request IDs permanently. Bind immutable fingerprint to action, exact workspace/id/expected revision/config and a **keyed credential digest**, never plaintext secret in the receipt. Changed payload reuse conflicts. A recovered request returns the exact prior receipt, never re-applies the effect. A create ID must not adopt a same-name replacement; update/disconnect CAS exact revision.
4. Atomically publish canonical config/credential reference/revision/receipt in existing connection authority; no network/keychain await inside a DB transaction. If staging custody is required, journal it before publication and retain uncertain state for explicit recovery. Disconnect removes only that connection's credential, invalidates leases, and never rewrites unrelated defaults. A selected default must be explicitly resolved by root, not silently changed here.
5. Material endpoint/key/model/disconnect changes call subscribed listeners immediately for the same workspace/connection; data-only catalog recording must not cancel its own probe or advance the material revision.
6. `recordProbe` CAS-checks identity, preserves last-known models/observedAt on unsuccessful discovery, marks that snapshot stale with a new attemptedAt, and never presents stale as fresh. An actual fresh empty list is `empty`, not unavailable. Storage here is durable only when root binds it.
7. `assertCurrent` validates active workspace/runtime owner, revision, configured state and shutdown/admission state before/after awaits. A scope switch or disconnect cancels current work, not reconnect/replay it.

No second registry/key store/migration ladder was introduced. Root owns the secure authority and appended migration, and must not claim durability before binding it.

## Exact root integration fragments

### Shared contract and provider gates

Export `./desktop-custom-provider.js` from the contracts barrel. If root also imports upstream `custom-provider.ts`, reconcile its same-named default constant explicitly rather than duplicate barrel exports. Add `'custom'` to existing provider/connection/settings schemas and labels **only once**. Preserve all existing Codex/Claude handlers and defaults. Add baseUrl/contextWindow/vision/policy/revision fields to canonical connection config/public projection under root ownership; credentials stay outside config/env.

### Engine initialization and inference

```ts
import { bindRegisteredCustomConnection, createCustomProviderRuntime } from './desktop/custom-providers/index.js'
// Required missing root secure authority; do not use an in-memory/default-success substitute.
const customRuntime = createCustomProviderRuntime(bindRegisteredCustomConnection(secureConnectionAuthority))
```

In existing `agents/providers.ts` custom branch, resolve exact workspace/connection/revision from the same admitted run authority, then:

```ts
const bound = await customRuntime.model(identity, modelId, runAbortSignal)
return { model: bound.model, close: bound.close, quickReplies: existingQuickRepliesRead }
```

Root preserves current quick-reply/card/fake-tool guards by composing its existing middleware around this actual model; do not install a second agent loop or bypass tool grants. This source has no current auto-fallback branch.

Current compaction `runtime/compaction/compact.ts:summarizeMiddle` calls `modelFor`; root must route a custom-resolved model to this SAME runtime and contextWindow projection, retaining its existing auth release/finally and timeout. Auxiliary title/vision/research one-shot paths must resolve exact connection+revision too:

```ts
await customRuntime.oneShot(identity, modelId, existingGenerateInput, callerAbortSignal)
```

Ordinary streaming may use the model in the existing stream loop, or `customRuntime.stream`; in both cases root closes the bound lease in the run finalizer, after consuming/cancelling output. Keep existing cancellation/Stop ownership. Close runtime and await existing active run drain on workspace switch, disconnect and Quit. Restart restores saved snapshot only; no background catalog refresh/probe/inference.

### Authenticated Settings route and B adapter

Mount one UI API instance through existing `desktopRoute`, after secure connection authority exists:

```ts
import { createDesktopCustomProviderApi } from '@/lib/desktop/server/custom-providers'
const customApi = createDesktopCustomProviderApi(secureConnectionAuthority)
export async function POST(request: Request) {
  return desktopRoute(request, runtime => customApi.request(runtime, request))
}
```

Proposed root-owned mount: `apps/ui/app/api/desktop/custom-providers/route.ts`. This is a Settings-only authenticated route, not a model-callable tool or external listener. Root bridges engine/UI authority through existing authenticated internal custody; this package exports no keys or renderer credential bridge. B consumes the exact canonical request/response schemas above and must not invent another wire format.

B's AddCustomProviderPage equivalent calls explicit `probe_draft` after policy review; offers a manual model if discovery is unavailable; never treats saved configuration as usable proof. Create uses stable requestId and fresh connectionId, then read/probe by exact returned revision. Update/disconnect use current revision. Same-ID retry recovers receipt; edited payload starts a new request only after prior uncertainty is resolved. Masked API key input is cleared after submission; flags only on restore. No localStorage, transcript or error logging of keys.

### Root migrations

Root appends the migration that adds durable custom metadata/catalog and permanent request receipts to the EXISTING connection authority, with encrypted credential references into EXISTING secure custody. Root chooses the next ladder index (none allocated by A). Do not add a second connection catalog or use service-install secrets under fake coworker IDs. Until this authority, provider enum registration, model resolution and route mounts are integrated, Settings must show this capability unavailable rather than allow a connection that cannot run/recover securely.

## Implemented / dependent / unsupported

| Area | Status | Limits |
| --- | --- | --- |
| Canonical presets/DTOs | Implemented source | B/root barrel integration required; no UI edited |
| Actual chat model, streaming, one-shot, reasoning | Implemented source | Requires exact secure authority and existing root run lifecycle/tool guards |
| Bounded endpoint/DNS/redirect policy | Implemented source | Per-connection review mandatory for local HTTP/private addresses; no global allowance |
| Draft and saved probes/manual fallback | Implemented source | Explicit action only; no automatic endpoint test on read/restore |
| Context/vision projection | Implemented source | Unknown context defaults 128k; root keeps actual prompt compaction; vision explicit |
| Registry adapter | Implemented source | Exact current getConnection fence; never consumes env keys |
| Encrypted provider custody/revisions | Dependent — absent from existing canonical connection authority | No new key store and no plaintext fallback authored |
| Durable create/update/disconnect/receipt replay/catalog | Dependent — required root authority contract above | API delegates; no successful durability claim for an unbound port |
| Settings route/enums/provider registration/auxiliary callers | Dependent — root owned | Source availability does not enable a provider |
| OAuth/ChatGPT credential reuse/Responses API/custom headers | Unsupported | Optional Bearer only; no fallback, redirects, URL credentials or model-selected endpoint |
| Unbounded models/output/automatic probes/Docker host rewrite | Unsupported | Fixed caps and explicit manual action |

## Regression sources, authored and unrun

- Model-list empty vs malformed, context aliases, exact IDs/deduplication.
- Explicit local policy, origin mismatch/URL credentials, private/metadata/mapped IPv6 refusal, no Docker substitution.
- Optional-key actual SDK one-shot fixture, explicit model, context precedence.
- SSE fixture reasoning_content vs answer separation through existing middleware.
- Wrong workspace/revision/model, connection replacement aborting a live lease.
- Discovery unavailable with separately successful manual-model fixed-token fixture.
- API cross-workspace mutation denial and fixed errors never containing submitted secret text.

No fixture or test was executed. Durable lost-ACK, restart and credential-replacement integration scenarios cannot be validated with a real canonical secure provider authority because that authority is absent; root must author/execute its migration and receipt integration tests when binding it. This source handoff identifies that blocker rather than fabricate a passing persistence fixture. Full provider completion and installed/native acceptance are pending root.
