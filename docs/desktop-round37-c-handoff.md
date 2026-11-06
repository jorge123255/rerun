# Round 37 C — OpenCode Go and Console runtime

Implementation: `3046db1c5bcb274927d2d80a1aa8b20600abd6ba` on `desktop/round37-opencode-runtime`.

Base: `e87edabffded9b56c67f98539a412e230959435c`. Runtime ancestor: `81f1c62a7b9fb0ac1f44bbee77c21e0f4aa576f5`. Compared with read-only upstream `2a57fa6dd53311f763bfc9abde85997b7f7e5309` (`upstream-review-20261106`). That commit is not an ancestor of this base. Historical pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` stays the earlier acceptance pin. Round 36 is not in this base and was not edited.

No checks were executed. No typecheck, lint, build, install, server, fixture run, provider call, Docker, browser, native UI, microphone, Keychain, or restart check. This is not installed acceptance. Root owns review, fixes, tests, packaging, and board acceptance. The Codex-only connected state is unchanged. Source preparation does not connect an account or authorize spending.

## Contract for D

`packages/contracts/src/desktop-opencode.ts`. `DESKTOP_OPENCODE_CONTRACT_VERSION = 1`. Provider id `opencode`. Token `OPENCODE_API_KEY`. Not an OpenRouter endpoint and not a ChatGPT credential.

D should import these names from `@rerun/contracts` only after root adds the barrel export and rebuilds dist. Until then the symbols are not on the package entry. Do not invent a second catalog or account shape.

- Identity: `DESKTOP_OPENCODE_PROVIDER`, `DESKTOP_OPENCODE_TOKEN_KEY`, `DESKTOP_OPENCODE_PLANS`, `DESKTOP_OPENCODE_DEFAULT_MODEL` (`go/deepseek-v4-pro`), `DESKTOP_OPENCODE_ONE_SHOT_SESSION` (`agent-oc:one-shot`), `DESKTOP_OPENCODE_SESSION_HEADER` (`x-opencode-session`)
- URLs: `DESKTOP_OPENCODE_CATALOG_URL.go`, `DESKTOP_OPENCODE_CATALOG_URL.console`, `DESKTOP_OPENCODE_USAGE_URL`
- Catalog: `desktopOpencodeModelSchema`, `parseDesktopOpencodeCatalog`, `DESKTOP_OPENCODE_SNAPSHOT` (96 shipped models), `desktopOpencodeDefaultModelIds` (Go only, default first), `desktopOpencodeRefreshSchema`
- Rows and locks: `desktopOpencodeModelRows`, `DESKTOP_OPENCODE_PLAN_DESCRIPTION` (`Included in Go` / `Console credits`), `desktopOpencodeEnableProblem`. Console lock copy: `Off until you switch Console on.`
- Credentials and windows: `desktopOpencodeKeyProblem`, `desktopOpencodeWindowSchema`, `desktopOpencodeWindows`
- Dispatch: `desktopOpencodeDispatchSchema`, `desktopOpencodeResultSchema` (`saved | partial | unknown | refused`)
- Resolution: `desktopOpencodeBehaviour`, `desktopOpencodeVisionModel` (cheapest seeing Go model; Console is never the vision fallback)

Client actions on `desktopOpencodeRequestSchema` in `apps/ui/lib/desktop/server/opencode/publisher.ts`:

| Action | Effect |
| --- | --- |
| `prepare` | Validates a key with `desktopOpencodeKeyProblem`. Stores nothing. No network. |
| `catalog` | Display read. `fresh` is forced false. Does not execute. |
| `refresh` | Explicit catalog refresh for one workspace and request id. |
| `usage` | Stored windows, or an explicit refresh when `refresh` is true. A failed refresh does not refuse the key. |
| `enable` | `desktopOpencodeEnableProblem`. No network. |
| `disconnect` | Forgets usage rows only. Keeps call receipts. No network. |
| `execute` | Receipt-scoped chat, Foreman, or auxiliary dispatch. |

`publishDesktopOpencode` is the client adapter. `handleDesktopOpencode` is the loopback handler. Both stay unavailable until root binds ports.

## Changed files

- `packages/contracts/src/desktop-opencode.ts`
- `apps/engine/src/desktop/opencode/catalog.ts`
- `apps/engine/src/desktop/opencode/limits.ts`
- `apps/engine/src/desktop/opencode/wire.ts`
- `apps/engine/src/desktop/opencode/stream.ts`
- `apps/engine/src/desktop/opencode/model.ts`
- `apps/engine/src/desktop/opencode/execute.ts`
- `apps/engine/src/desktop/opencode/index.ts`
- `apps/engine/src/desktop/opencode/opencode.test.ts` (authored, not run)
- `apps/engine/src/desktop/opencode/__fixtures__/captured-catalog.json`
- `apps/engine/src/desktop/opencode/__fixtures__/limits.json`
- `apps/engine/src/desktop/opencode/__fixtures__/chat-go.sse`
- `apps/engine/src/desktop/opencode/__fixtures__/messages-console.sse`
- `apps/engine/src/desktop/opencode/__fixtures__/responses-go.sse`
- `apps/engine/src/desktop/opencode/__fixtures__/google-go.sse`
- `apps/ui/lib/desktop/server/opencode/authority.ts`
- `apps/ui/lib/desktop/server/opencode/store.ts`
- `apps/ui/lib/desktop/server/opencode/publisher.ts`
- `apps/ui/lib/desktop/server/opencode/publisher.test.ts` (authored, not run)
- `apps/ui/lib/desktop/server/opencode/server.ts`
- `apps/ui/lib/desktop/server/opencode/index.ts`

## Original mapping

| Original | Owned |
| --- | --- |
| `packages/contracts/src/opencode.ts`, `opencode-snapshot.ts` | `desktop-opencode.ts` plus the embedded snapshot |
| `apps/engine/src/connections/opencode-catalog.ts` | `catalog.ts` |
| `apps/engine/src/connections/opencode-plan-limits.ts` | `limits.ts` |
| `apps/engine/src/agents/opencode.ts` | `model.ts`, `execute.ts`, `wire.ts` |
| `apps/engine/src/agents/opencode-stream.ts` | `stream.ts`, usage helpers in `wire.ts` |
| `apps/engine/src/agents/__fixtures__/opencode/*.sse` | copied fixtures |

Preserved: one key, two catalogs, ids `go/<upstream>` and `console/<upstream>`, public catalog URLs, usage URL, session header, redirect error, Go cost 0, Console `list_cost`, cache write `cache_write_5m + cache_write_1h`, 401 key refused, 402 credits even on a Go model, 400 `model is unavailable` refreshes the catalog, 429 becomes a Go window limit only when a spent window is known. Snapshot absence is not retirement. A failed refresh keeps the last live reading, then the snapshot, and is never `fresh`.

## Adapters

- `desktopOpencodeLanguageModel` builds Anthropic Messages, OpenAI Responses, OpenAI Chat, or Google from the explicit `apiKey`, `baseURL`, and a bound fetch. No SDK `name`, so each SDK keeps its own `providerOptions` key. Middleware reuses `openrouterStreamRetryMiddleware` and `googleToolSchemaMiddleware`. Chat reasoning imports `chunkReasoningDelta`.
- `executeDesktopOpencode` is the receipt path. Injected `fetch` only. Same URLs and headers as `desktopOpencodeHttpRequest`. Upstream id only. `redirect: 'error'`.
- `DesktopOpencodeAuthority.current` is the credential port. Root decrypts `OPENCODE_API_KEY` and passes it in. This lane does not read Keychain, `process.env`, or `catalog.json`.
- `sqliteDesktopOpencodeStore` reads tables root creates. `memoryDesktopOpencodeStore` is the test double. Neither creates tables.
- Catalog readings and usage readings are keyed by workspace, then plan or connection. One workspace cannot publish another's live list.

## Root fragments

Barrel, after the existing desktop exports in `packages/contracts/src/index.ts`, then rebuild `@rerun/contracts`:

```ts
export * from './desktop-opencode.js'
```

`packages/contracts/src/agent.ts` `providerSchema`: add `'opencode'` in the same change as the token map. Do not add it alone.

`packages/contracts/src/connection.ts`:

```ts
opencode: 'OPENCODE_API_KEY' // CONNECTION_TOKEN_KEY
opencode: [] // CONNECTION_SATELLITE_KEYS
opencode: desktopOpencodeDefaultModelIds() // DEFAULT_CONNECTION_MODELS, Go only
opencode: 'OpenCode' // PROVIDER_LABELS
```

`planLimitWindowSchema` is `session | weekly | model` and has no `monthly`. Keep using `desktopOpencodeWindowSchema` (`session | weekly | monthly`, `label: null`) until that enum grows. Do not store a monthly window as `model`.

`apps/ui/lib/desktop/settings.ts`: add `'opencode'` to `desktopProvider` only after `providerSchema` includes it. The key action calls `desktopOpencodeKeyProblem`. Do not reuse the OpenRouter endpoint editor. A ChatGPT sign-in must not write `OPENCODE_API_KEY`.

`apps/ui/lib/desktop/server/chat-model.ts`: resolve OpenCode from the workspace connection revision and model. A missing, retired, or foreign model is 409. No silent Codex or OpenRouter fallback.

`apps/engine/src/agents/providers.ts` `registryFor`, `resolveModel`, and `modelFor`: when the provider is `opencode`, call `desktopOpencodeLanguageModel` with the connection key, workspace id, connection id, and session id. Wrap with `built.middleware`. One-shot with no session uses `agent-oc:one-shot`. Pass `consoleEnabled: true` only when that connection has switched Console on. Do not call `env()` for this key and do not point the base URL at OpenRouter.

Compaction: for an OpenCode model, the context window is `desktopOpencodeContextWindow(workspaceId, modelId)`. Null means unavailable.

Availability: unbound ports, a rejected key, or a disconnected connection is unavailable.

`apps/ui/app/api/desktop/engine/opencode/route.ts` (root creates this file):

```ts
import { handleDesktopOpencode } from '@/lib/desktop/server/opencode/server'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const GET = handleDesktopOpencode
export const POST = handleDesktopOpencode
```

Bind before the route can succeed. Unbound returns 503 `{ status: 'refused', code: 'unavailable', sent: false }`.

```ts
bindDesktopOpencodePorts({
  authority, // { current } returns the decrypted snapshot for that workspace and connection
  store: sqliteDesktopOpencodeStore(db),
  execute: input => executeDesktopOpencode(input),
  refreshCatalog: input => refreshDesktopOpencodeCatalog({ ...input, fetch }),
  refreshLimits: input => refreshDesktopOpencodeLimits({ ...input, fetch }),
})
```

GET is a catalog read. POST `saved` is 200. Any other result that carries `status` is 409. Catalog and usage observations have no `status` and stay 200, including a snapshot fallback.

Schema: do not reuse versions 25–30. Version 30 is `foreman-company-intake` in `round35-schema.ts`, and `workspaces/schema.ts` also proposes version 30 `local-workspace-catalog`. Round 36 recommended 31 `shared-file-mutation-receipts` and is not in this base. Use 31 `opencode-go-console-receipts` only when 31 is still free; otherwise use the next integer. SQL: `DESKTOP_OPENCODE_SCHEMA_SQL` from `apps/ui/lib/desktop/server/opencode/store.ts`. Append it in the root migration ladder. This branch does not run it. No Supabase.

`packages/contracts/src/chat-error.ts`: duplicate `DESKTOP_OPENCODE_CREDITS_USED_UP` and `DESKTOP_OPENCODE_GO_LIMIT`. Classify 402 and the Go-limit sentence as usage limit, a plain 429 as overloaded, a 401 key refusal as unauthorized, a 400 retired model as refused, and `TypeError: fetch failed` as unknown. Owned execute already returns its own codes.

Settings copy for D: Go is "Included in Go". Console is "Console credits" and "Billed per token from your OpenCode credits. Off until you switch one on." Console sorts after Go. `isNew` is an id absent from `DESKTOP_OPENCODE_SNAPSHOT`. Retired rows appear only when the catalog source is `live`.

## Lifecycle

- Same `workspaceId + connectionId + runId + requestId` and the same digest replays the stored result and does not send again.
- A different digest on that id throws `Tool call identity was reused`.
- Stop before send stores `refused` / `cancelled` / `sent: false` and does not fetch. Replay stays unsent.
- A claim with no result replays as `unknown` and does not send again.
- A finished `saved` or `partial` result is kept if Stop is already set when the body comes back.
- A stream with text and no terminal frame is `partial`. No text and no terminal frame is `unknown`.
- A completed frame stays `saved`.
- Usage HTTP failure records nothing and does not refuse the key. Inference 401 does.
- 400 `model is unavailable` refreshes that workspace's catalog and returns `retired`.
- Go 429 refreshes usage for that connection. A spent window uses `OpenCode Go limit reached: <window> window · resets <UTC>`. If usage does not answer, the result stays `unknown`.
- Catalog display never calls execute. Disconnect never calls the provider.

## Matrix

| | |
| --- | --- |
| Implemented | Contract version 1, snapshot, parser, Go/Console ids, key rejection, windows, refresh with fallback, four wire requests, SSE normalization, SDK factory, receipt execute, authority port, SQL, loopback handler, unrun regressions |
| Dependent on root | Barrel export and dist rebuild, `providerSchema`, token map, satellites, default models, label, Settings filter, registry/`modelFor`, chat-model 409, compaction window, availability, route file, schema step, `chat-error` classifier, D's presentation |
| Unsupported here | Live account connect, spending, Keychain reads, env credentials, OpenRouter or ChatGPT reuse, central registry edits, dependency upgrades, applying migrations, running tests, installed or restart acceptance |

## Limitations

- `REASONING_ID` and `closesReasoning` are not exported from `openrouter-reasoning.ts` on this base. `stream.ts` imports `chunkReasoningDelta` and repeats the close predicate and the id `reasoning-0`. It does not add OpenRouter's reasoning request fields. Root can export those two symbols later; do not change the bundled runner in this lane.
- This base has no `opencodeUserAgent()`. The default User-Agent is `rerun-desktop-opencode/1`. Pass another string once root has one.
- `desktopOpencodeKeyProblem` requires `oc_sk_` and rejects `eyJ`, `sk-ant-`, `sk-or-`, and any other `sk-`. Upstream storage validation only required a non-empty key. The stricter rule is intentional so a ChatGPT, Anthropic, OpenAI, or OpenRouter token cannot be stored as OpenCode.
- In-memory catalog and usage state live in the engine process. The SQL rows are the durable copy after root migrates. A display read sets `fresh: false` even when the stored source is `live`, and keeps `capturedAt` so age stays visible.
- One plan answering and the other failing is `cached`, never `live`.
- The SDK factory and `executeDesktopOpencode` are both real adapters. The agent loop should use the factory. The loopback route should use execute so a receipt exists. Neither runs because this branch does not mount them.
- Nothing in these files reads a live database, the installed preview, or a provider at import time.
