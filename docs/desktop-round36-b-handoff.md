# Round 36 — Agent B handoff: external-client keys, admission, and loopback MCP (W4)

Worktree `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round36-external-mcp-authority`, branch `desktop/round36-external-mcp-authority`, base `970415507e28824bb001f46c8537d20fd2636b1c`. Original pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

This file is part of the one local commit on that branch. The commit SHA is the commit that adds this file; it is not written inside the file. Parent is the base above.

**No tests, typecheck, lint, build, install, server, Docker, provider call, browser, Keychain, or Mac/restart check was executed. This commit is not installed acceptance. W4 stays open.** Root reviews, repairs, and accepts. Do not send a repair back to this lane as if the feature were live.

## Dependent contracts

- Workspace ids match desktop-workspaces contract version 1 `desktopWorkspaceIdSchema`: positive int, max `1_000_000`. That file was read from integration commit `052f6f66f8f8eaca27d5ea878d2cf3024e617dc0` (`packages/contracts/src/desktop-workspaces.ts`). It is **not** in this worktree. This package does not copy the catalog and does not invent `installId`. `externalMcpWorkspaceIdSchema` is only the id constraint. `LEGACY_DESKTOP_WORKSPACE_ID` is 1. Selection, `admissions_frozen`, and isolation domain `local_mcp` stay on that contract.
- `apps/desktop/src/main/workspaces/ports.mjs` in that same integration commit still documents missing root authorities W1-A1 through W1-A6. This base's `readRuntimeIdentity` is `{ workspaceId, launchNonce, dataRoot } | null` with `workspaceId` hard-coded to 1. Until root binds `ExternalMcpRuntimeAuthority`, `read()` returns null and admit/enable return `authority_missing`.
- Agent C inventory commit `9af9a32b79433357473fe9de547791bc2b1c55c5` on `desktop/round36-external-mcp-tools` is not a principal or a tool registry. Do not register that inventory as runnable tools. Sharing and billing have no scope here.

## Original mapping (pin a6d63a4)

| Original | Local |
| --- | --- |
| `apps/ui/app/api/mcp/account/route.ts` stateless JSON-RPC POST. Bearer key. Notifications `202`. `initialize` versions `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`, default `2025-06-18`, capabilities `{ tools: {} }`, serverInfo `rerun` `1.0.0`. `tools/list` / `tools/call`. Unknown method `-32601`. Parse error `-32700`. | `handleExternalMcpMessage` keeps that subset. `ListToolsRequestSchema` and `CallToolRequestSchema` from `@modelcontextprotocol/sdk` `^1.29.0` validate list and call. No `StreamableHTTPServerTransport`, no SSE session, no URL token, no CORS header. |
| `apps/ui/lib/mcp/api-keys.ts` prefix `rk_`, 30 `base64url` bytes, SHA-256 hex, display prefix 12, lookup by hash, `revoked_at` nulls auth. `isWorkspaceApiEntitled` (sandbox entitled). `last_used_at` best-effort. | `custody.ts` matches the mint and hash. Desktop does **not** copy the subscription gate. `last_used_at` is best-effort and does not fail admission. |
| `apps/ui/app/api/_actions/api-keys.actions.ts` `MAX_ACTIVE_KEYS = 20`, `MAX_NAME_LENGTH = 60`. List hides revoked. Create returns the secret once. Revoke stamps `revoked_at` for that workspace. | Same caps and messages in `EXTERNAL_MCP_COPY`. Expired keys stay visible. Create refuses an expiry already in the past. |
| `apps/ui/components/dialogs/ApiKeysDialog.tsx` and `apps/ui/lib/mcp/connect.ts` | Not edited. Copy for D is `EXTERNAL_MCP_COPY`. Snippets must use the loopback listener origin plus `/mcp`, not `/api/mcp/account` and not the engine origin. Placeholder remains `rk_`. Authorization Bearer. |
| `apps/engine/src/cli/commands/desktop-run.ts` loopback Host, Origin, engine key `timingSafeEqual`, `workspaceId: z.literal(1)` | Not edited. The external listener does not use `RERUN_API_KEY` as a client credential and does not accept the engine key. Management routes, once mounted, stay on the engine origin behind that existing bearer. |
| `apps/engine/src/http/auth.ts` | Not edited. The external listener does not call it. |
| `apps/engine/src/config/paths.ts`, `systemDb.ts`, contracts barrel, `policy.ts`, checklist | Not edited. Fragments are below. |

## Implementation inventory

- `packages/contracts/src/desktop-external-mcp.ts` — contract version 1. Not on the barrel.
- `apps/engine/src/desktop/external-mcp-authority/schema.ts` — `DESKTOP_EXTERNAL_MCP_SCHEMA_SQL`. Sibling sqlite. No secret column. Not `system.db`.
- `apps/engine/src/desktop/external-mcp-authority/{custody,authority,dispatch,http-guards,protocol,listener,service,router,runtime,index}.ts` — hash custody, unbound runtime port, one dispatch registration, loopback guards, JSON-RPC subset, default-off listener, durable service, unmounted management router, store init.
- `apps/engine/src/desktop/external-mcp-authority/service.test.ts` — authored regressions, not run. Injected `listen` does not bind a port.
- `apps/ui/lib/desktop/server/external-mcp-authority/client.ts` — engine-origin client for D. `server-only`. Bearer is `runtime.engine.apiKey`.
- `apps/ui/lib/desktop/server/external-mcp-authority/display.ts` — re-exports `externalMcpDisplayedSecret` for a client component.

## Public contract

`DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION = 1`.

C and D consume `packages/contracts/src/desktop-external-mcp.ts` from this commit. Do not invent a second principal, key, grant, or receipt.

Exports they need:

- Identity: `externalMcpWorkspaceIdSchema`, `externalMcpPrincipalSchema`, `ExternalMcpPrincipal`, `externalMcpGrantSchema`, `ExternalMcpGrant`, `externalMcpKeyViewSchema`, `ExternalMcpKeyView`.
- Scopes: `EXTERNAL_MCP_SCOPES`, `externalMcpScopeSchema`, `EXTERNAL_MCP_DEFAULT_SCOPES` (`['mcp:read']`), `EXTERNAL_MCP_REFUSED_SCOPES` (`*`, `mcp:admin`, `credentials`, `mcp:*`). Grantable writes: `coworkers:write`, `schedules:write`, `triggers:write`, `connectors:write`, `runs:send`, `data:write`. No share, billing, members, or hosted-account scope.
- Keys: `EXTERNAL_MCP_KEY_PREFIX` `rk_`, `EXTERNAL_MCP_PREFIX_LENGTH` 12, `EXTERNAL_MCP_NAME_MAX` 60, `EXTERNAL_MCP_ACTIVE_KEY_MAX` 20, `EXTERNAL_MCP_COPY`.
- Transport: `EXTERNAL_MCP_PATH` `/mcp`, `EXTERNAL_MCP_REQUEST_HEADER` `x-rerun-external-request-id`, `EXTERNAL_MCP_PROTOCOL_VERSIONS`, `EXTERNAL_MCP_DEFAULT_PROTOCOL_VERSION`.
- Receipts and refusals: `externalMcpReceiptSchema`, `ExternalMcpReceipt`, `externalMcpRefusalSchema`, `EXTERNAL_MCP_REFUSAL_CODES`. A receipt has `secretAvailable` and never the secret.
- Create / revoke / list: `externalMcpCreateInputSchema`, `ExternalMcpCreateInput` (output, defaults applied), `ExternalMcpCreateRequest` (`z.input`, `scopes` and `expiresAt` optional), `externalMcpCreateResultSchema`, `externalMcpRevokeInputSchema`, `externalMcpRevokeResultSchema`, `externalMcpListResultSchema`, `externalMcpListResponseSchema` (list or refusal).
- Listener: `externalMcpListenerViewSchema`, `externalMcpEnableInputSchema`, `externalMcpListenerResultSchema`.
- Live check: `externalMcpLiveCheckInputSchema`, `externalMcpLiveCheckResultSchema`.
- Dispatch: `externalMcpToolRegistrationSchema` (effect tool cannot be `mcp:read`; read tool must be `effect: false` and `mcp:read`), `externalMcpCallContextSchema`, `externalMcpToolResultSchema`, `ExternalMcpDispatchPort`.
- Helpers: `externalMcpCanonicalJson`, `externalMcpDisplayedSecret`.

Engine registration, not the contract file:

- `bindExternalMcpRuntimeAuthority` / `readExternalMcpRuntimeAuthority` / `EXTERNAL_MCP_RUNTIME_AUTHORITY` (`'ExternalMcpRuntimeAuthority'`).
- `registerExternalMcpDispatch` / `readExternalMcpDispatch`. A second, different object throws `External MCP dispatch is already registered.`
- `getExternalMcpService().recheck(input)` before and after every await inside an admitted operation. `initializeDesktopExternalMcp` / `closeDesktopExternalMcp`. `createDesktopExternalMcpRouter`.

UI for D:

- `listDesktopExternalMcpKeys(runtime, workspaceId)`
- `createDesktopExternalMcpKey(runtime, input)`
- `revokeDesktopExternalMcpKey(runtime, input)`
- `readDesktopExternalMcpListener(runtime)` — one listener; the view carries the bound workspace. The argument does not select a workspace.
- `enableDesktopExternalMcpListener` / `disableDesktopExternalMcpListener`
- Render `EXTERNAL_MCP_COPY` and `externalMcpDisplayedSecret`. A hash, a recovered create, or a null secret renders nothing.

## What the service actually does

Sibling file `resolve(dataDir(), 'external-mcp-db', 'external-mcp.db')`, created with `prepareDesktopDataFile` and `verifyDesktopDataFile`. Tables `desktop_external_mcp_keys` and `desktop_external_mcp_receipts`. No secret column.

Create stores `key_hash` and a 12-character prefix. `secret_delivered` flips from 0 to 1 in one conditional update. Only `rowsAffected === 1` returns the secret. The same `requestId` returns `secret: null`, `secretAvailable: false`, and `EXTERNAL_MCP_COPY.secretDiscarded`. A failed insert with no stored row returns `uncertain` and does not invent a secret. Receipt JSON never contains the secret.

The listener default is off. `initialize` runs DDL, marks `status = 'pending'` receipts `uncertain`, closes the listener, and mints nothing. The same enable `requestId` after restart returns the stored receipt and the live view (off) and does not listen. A new `requestId` is a new opt-in. `openExternalMcpListener` binds `127.0.0.1` port 0 and rejects any other address.

Every admit checks the bearer, rejects the engine key with `timingSafeEqual` (same `Unauthorized` message, including an `rk_` value equal to the engine key), hashes the token, and checks workspace, revocation, expiry, and `gate`. `gate` requires a bound snapshot with `installId` and `launchNonce`, refuses `stopping`, `admissionsFrozen`, and a different `workspaceId`. `reconcile` closes the listener and aborts owned streams when the snapshot is missing, stopping, frozen, or the workspace, launch nonce, or install id changed.

Host must equal `127.0.0.1:<bound port>`. Any `Origin` is 403. Any path other than `/mcp`, or any search string, is 400 `forbidden_url`. Remote address must be `127.0.0.1` or `::ffff:127.0.0.1` (`::1` and a missing address are refused). POST only.

`tools/list` with no dispatch, or a registration that fails the schema, is JSON-RPC `-32001` `External MCP tools are not connected.` It is not `{ tools: [] }`. An unknown tool is JSON-RPC `-32001` `Unknown tool.` A read `tools/call` needs only `mcp:read` and the bearer. An effect `tools/call` needs a published write scope and header `x-rerun-external-request-id` (uuid). Without that header the tool is not called (`400`, `invalid`).

Effect custody: the same request id and fingerprint returns the stored tool result and does not call dispatch again. A different fingerprint is `409` `replay_conflict`. Column `pending` is `409` `in_flight`. After restart a pending row is `uncertain` and is not replayed. A failure after the receipt is inserted discards the tool payload, stores `uncertain`, and returns that uncertainty. The client JSON-RPC id is preserved on success and on JSON-RPC errors.

In-flight work is an `AbortController` aborted on revoke of that key, disable, workspace switch, stop, freeze, install or launch change, and shutdown. Only the request `aborted` event aborts the inbound call. The request `close` event is not used, because Node emits it when the body has been read.

## Root activation fragments

Do not apply these in this worktree. Rebuild `@rerun/contracts` after the barrel line. Engine and UI imports resolve only then. Do not relative-import `packages/contracts/src` from the engine.

`packages/contracts/src/index.ts`, after the last desktop export:

```ts
export * from './desktop-external-mcp.js'
```

`apps/engine/src/cli/commands/desktop-run.ts`, with the other desktop imports:

```ts
import { createDesktopExternalMcpRouter } from '../../desktop/external-mcp-authority/router.js'
import { closeDesktopExternalMcp, getExternalMcpService, initializeDesktopExternalMcp } from '../../desktop/external-mcp-authority/runtime.js'
import { bindExternalMcpRuntimeAuthority } from '../../desktop/external-mcp-authority/authority.js'
```

After `await initializeDesktopBrainStore()`, still inside startup. Do not enable the listener here:

```ts
await initializeDesktopExternalMcp()
```

With the other `app.route` calls, before `app.route('/', createServer())`:

```ts
app.route('/desktop/external-mcp', createDesktopExternalMcpRouter(getExternalMcpService))
```

Inside the shutdown `Promise.allSettled` list:

```ts
closeDesktopExternalMcp()
```

`apps/engine/src/desktop/policy.ts`, inside `desktopRouteAllowed`:

```ts
if (path === '/desktop/external-mcp/keys' && (method === 'GET' || method === 'POST')) return true
if (path === '/desktop/external-mcp/keys/revoke' && method === 'POST') return true
if (path === '/desktop/external-mcp/listener' && method === 'GET') return true
if (path === '/desktop/external-mcp/listener/enable' && method === 'POST') return true
if (path === '/desktop/external-mcp/listener/disable' && method === 'POST') return true
```

This worktree's datadir ladder ends at version 5 (`desktop-portable-templates-and-semantic-memory`). Integration HEAD `38aadc9a2568581f849bcbb4a48570640f5aef9e`, read while this handoff was written and not part of this worktree, already has version 6 `desktop-company-brief-brain-semantic-and-workspace-routines`. Append the next free integer. Do not reuse 6. Id `desktop-external-mcp`. Re-read the ladder before applying; a later integration commit may already have taken the next integer.

```ts
import { initializeDesktopExternalMcp } from '../desktop/external-mcp-authority/runtime.js'

{
    version: /* next free integer */,
    id: 'desktop-external-mcp',
    up: async () => {
        if (!desktopApp()) return
        await initializeDesktopExternalMcp()
    },
}
```

Root binds the runtime from the Round 35 coordinator. `installId` comes from the catalog, `launchNonce` from the running runtime, `workspaceId` from the selection (not from a request string), `admissionsFrozen` from W1-A2, and `stopping` from shutdown. Return null until W1-A1, W1-A2, and W1-A3 exist. Until that bind, admit and enable stay `authority_missing` and name `ExternalMcpRuntimeAuthority`.

```ts
bindExternalMcpRuntimeAuthority({
    read: () => null,
})
```

Replace that `read` only when those authorities exist. Do not hard-code a second workspace catalog in this package.

C registers one `ExternalMcpDispatchPort` with `registerExternalMcpDispatch` after this package is on the branch C compiles. Do not register a stub that returns `[]`. An unregistered port makes `tools/list` return `adapter_missing`. C calls `getExternalMcpService().recheck` before and after every await. `callTool` must honor the `AbortSignal` and return `ExternalMcpToolResult`. Effect tools use one published write scope plus `x-rerun-external-request-id`. Reads use `mcp:read` only. Do not register C's inventory commit as tools.

D calls the UI functions and renders `EXTERNAL_MCP_COPY` plus `externalMcpDisplayedSecret`. Listener snippets use `listener.origin + '/mcp'`.

## Supported / dependent / unsupported

| | Supported here | Dependent on root | Unsupported |
| --- | --- | --- | --- |
| Contract | Version 1 principal, grant, key view, receipt, scopes, copy | Barrel export and contracts rebuild | A second principal or workspace catalog |
| Keys | Hash, one-time secret, expiry, revoke, 20 active, restart keeps the hash | Datadir step and `initializeDesktopExternalMcp` on desktop boot | Re-display from the hash; copying the engine key; cloud entitlement |
| Listener | Opt-in `127.0.0.1` port 0, default off, close on switch / stop / revoke / shutdown | `bindExternalMcpRuntimeAuthority` from W1; do not enable during boot | LAN, public bind, CORS, URL token, `::1`, browser Origin, SSE session |
| Admission | Workspace, revision, scopes, expiry, revoke, engine-key rejection | W1-A1, W1-A2, W1-A3 before admit can succeed | Implicit `*`, `mcp:admin`, `credentials`, share, billing |
| Dispatch | Port, recheck, effect request id, uncertain in-flight result | C's `registerExternalMcpDispatch` | Treating a missing adapter as `{ tools: [] }` or a successful tool result |
| Management UI | Server functions and one-time display helper | Mount, `desktopRouteAllowed`, D's dialog | Editing `ApiKeysDialog` or the cloud `/api/mcp/account` route |
| Restart | Listener stays off; pending receipts become uncertain; secrets are not minted | Boot calls `initializeDesktopExternalMcp` only | Auto-enable; recreating a discarded secret |

## Authored regressions (not run)

`apps/engine/src/desktop/external-mcp-authority/service.test.ts`

- Create stores a hash and prefix, the table has no `secret` column, and the same request id cannot display the secret again.
- Scope `credentials` is refused. A 64-hex engine key is unauthorized. An `rk_` secret that equals the configured engine key is unauthorized. A past expiry is `expired`. Switching the runtime snapshot to workspace 2 fails admit and disables the listener.
- An in-flight `send_message` (`runs:send`) is revoked after dispatch has started. The response does not contain `sent`. The same `x-rerun-external-request-id` does not call dispatch again.
- `initialize` after enable leaves the listener off and does not listen again. A service with no dispatch answers `tools/list` with `EXTERNAL_MCP_COPY.adapterMissing` and not `"tools":[]`. Host, Origin, and a query token are refused.

The in-flight case waits until `callTool` has registered its abort listener, then revokes. It does not use a fixed sleep on the success path. A call that never starts rejects after one second. Root runs this file. Injected `listen` does not open a real port.

## Limits

- Two concurrent creates of a new request id are not serialized beyond unique `create_request_id`. The loser returns the stored key with `secretAvailable: false`, or `uncertain` when no row exists. It does not mint a second secret for that id.
- After an effect receipt is inserted, a later refusal is stored and returned as `uncertain`. The tool text is not returned. The specific revoke code is not the HTTP result of that in-flight call. Pre-call refusals (unknown tool, missing scope, missing adapter, bad request id, replay, in-flight, live recheck) still use their own codes.
- A dispatch result that matches `externalMcpToolResultSchema`, including `isError: true`, is a recorded tool result. A throw or an abort is `uncertain`.
- `visibleTools` recheck uses a fresh `randomUUID()` and is not a receipt.
- List returns at most 20 non-revoked keys, active first, then expired. Older expired keys can be omitted. The create cap counts only non-revoked, non-expired keys.
- A new enable request id, while a matching listener is already open, inserts another receipt and does not open a second socket.
- The same enable request id after restart does not listen.
- `initialize` on a live process closes the listener and does not mint a key. Call it at boot, not on a timer.
- A second revoke of an already-revoked key does not move `revoked_at` or bump `revision`. A new request id still records a receipt.
- `last_used_at` is updated best-effort on admit. A failed update does not fail the call.
- Management routes are not mounted. `desktopRouteAllowed` still 403s them. `getExternalMcpService` throws 503 until init runs in `desktopApp()`.
- Unbound authority means admit and enable return `authority_missing`. The external listener is not started by import, mount, or restart.
- No CORS header is set. Any browser `Origin` is refused. Clients that omit `Accept: text/event-stream` can still POST JSON-RPC, because this is not the SDK streamable transport.
- W1-A1 through W1-A6 are not implemented here. W4 is not checked.
