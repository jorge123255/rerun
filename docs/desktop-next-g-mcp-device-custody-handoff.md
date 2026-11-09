# G — approved MCP device-attempt custody

Source delivery only. **No tests, fixtures, type checks, lint, builds, provider/network calls, app launches, microphone, Keychain, guest, permission, Mac board or cold-restart checks executed. No installed acceptance.** Root owns execution, review, fixes, migration allocation and activation.

## Pins and scope

- Fork: `jorge123255/rerun` (existing local origin).
- Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-g-mcp-device-custody`.
- Branch: `desktop/next-g-mcp-device-custody`.
- Base: `e233c3e415660f2d835562a1104dc47c433fe0a7`.
- Base tree: `3a79476593f2e455d01e163ea58928bd0381f39f`.
- Implementation: `ec8fac168838ae928128793f54b714cfffaad9f5`.
- Implementation tree: `d82adcf5dce73a787678ccd37d828e8f56021747`.
- The final documentation commit is a child of that implementation; use the reported Git tip rather than putting its self-referential SHA here.

The task supplied no new base SHA. The coding checkout was at `208038f5a24606c8834e7bdc1f352e81fa615c8e`, tree `8b1d6120fc22b40e215ae74c7911cb4c6746e535`, without the mounted login files. It was read only. I selected the previously verified fork checkpoint above, which contains the exact mounted files referenced by the task. The named worktree and branch did not exist. An empty, newly created lane at the coding HEAD was removed and recreated at the selected checkpoint before authoring source; no older worktree was changed. HEAD/tree/branch and clean status were verified before editing at the selected base. No reset, rebase, cherry-pick, network fetch, push, PR or merge.

Only new files under `apps/ui/lib/desktop/server/mcp-device-custody/` and this document changed. No central routes, registries, catalogs, existing approval/contracts, credentials, OAuth implementation, configuration defaults or migrations were edited.

## Changed files and exports

All paths below are relative to the worktree.

| Path | Purpose |
| --- | --- |
| `apps/ui/lib/desktop/server/mcp-device-custody/model.ts` | Server-only strict approved-method/start/poll/record shapes, named bounds, exact target aliases from existing fallback contract, receipt/slot digests. |
| `apps/ui/lib/desktop/server/mcp-device-custody/store.ts` | `desktopMcpDeviceCustodySchema`, `createDeviceCustodyStore`, `createEncryptedDeviceCustodyStore`. Canonical SQLite CAS reservations with existing secret crypto. No database/key opened at module load. |
| `apps/ui/lib/desktop/server/mcp-device-custody/custody.ts` | `createApprovedMcpDeviceCustody`, required authority/lifecycle ports, optional broker, `fallback`, passive `inspect`, exact `stop`, `dispose`. |
| `apps/ui/lib/desktop/server/mcp-device-custody/binding.ts` | `CanonicalDeviceCustodyBinding`, `bindApprovedMcpDeviceCustody`. Concrete existing run authority/store/lifecycle/credential binding; ready `dispatch` through the existing login backend. |
| `apps/ui/lib/desktop/server/mcp-device-custody/custody.test.ts` | Offline real SQLite/encryption custody regression source, synthetic fixture bytes only. |
| `apps/ui/lib/desktop/server/mcp-device-custody/binding.test.ts` | Offline production binding/backend/MCP store regression source; injected broker/probe, no fetch. |
| `docs/desktop-next-g-mcp-device-custody-handoff.md` | This handoff. |

The existing engine `ApprovedDeviceFallback`, `LoginIdentity` and `DeviceView` remain the canonical public/model contract. New shapes are private server custody records, not a parallel MCP registry or permission system. No barrel changes.

## Original and mounted comparison

Original community source inspected from the local Git object at `88d7b7bd7b360b215035ece2df87e76db7d27b71` (the most recently supplied original dev comparison pin in this conversation):

- `apps/engine/src/tools/builtin/self.ts`: original `mcp_login`, `mcp_login_complete`, `mcp_status` contracts/copy. Start saves pending device data, complete polls/saves tokens, then probes real tools. Fallback is separate from the Connect card.
- `apps/engine/src/tools/mcp-auth.ts`: `DeviceAuth`, `DeviceStart`, pending start time, device discovery/start/poll, token storage/refresh. Original pending files are plaintext restricted-mode engine files; this Mac slice uses existing encrypted app storage instead. Its hardcoded client/scope, discovery heuristics and network requests are not inherited as authorization.
- `apps/engine/src/tools/mcp.ts`: ordinary auth injection and tool adapter. No extra transport/pool created.
- `packages/contracts/src/chat-hitl.ts`: `request_mcp_sign_in` is a server-name/reason human interaction; it does not authorize an arbitrary device issuer/client/method.

Mounted local source consumed at the exact base:

- `apps/engine/src/desktop/mcp-login-tools/{backend,contract,route,tools,admission}.ts`.
- `apps/ui/lib/desktop/server/mcp-login-binding.ts` and `apps/ui/app/api/desktop/internal/mcp-login/route.ts`.
- `packages/contracts/src/desktop-mcp-sign-in.ts`, `apps/ui/lib/desktop/server/mcp-sign-in/{binding,runtime,store,schema}.ts`.
- `apps/ui/lib/desktop/server/mcp/{model,store,lifecycle,oauth-loopback,oauth-network}.ts`, `apps/ui/lib/desktop/server/mcp-binding.ts`.
- `apps/ui/lib/desktop/server/secret-requests/crypto.ts`.

The mounted route deliberately does not bind the backend's optional fallback. Existing human Connect is browser authorization-code PKCE, with no device-method approval field or trusted device broker. **That remains gated.** A browser Connect attempt, model tool input or mere method advertisement must not be cast into a device approval. This package does not modify the existing UI/copy or import hosted actions. Relevant installed Next route-handler guidance was read from the coding tree's UI dependency symlink, read only.

## Implemented behavior

1. Authority must return an explicit stable approval snapshot plus synchronous generation checker and abort signal. It binds canonical workspace, local owner, engine coworker, chat, immutable registration ID, revision, credential generation, method and approval expiry. The concrete binding also checks the current enabled/granted running context through existing `authorizeRun`, existing owner/server watchers, current HTTP registration and absence of manual bearer.
2. Only `device-code-link-v1` advances. It requires exact preapproved HTTPS resource/issuer/device/token/verification destinations and public client ID. Device/token/verification origins match the approved issuer. Endpoints have no query, fragment or URL credentials. Network address/TLS/redirect/broker validation remains required of the unbound broker authority; a syntactically accepted URL is not a network approval.
3. A dynamic verification destination, `userCode`, client-secret method, unknown field, extra token field or unsupported result is rejected. The model receives only the **preapproved public verification URI**, never a URI derived from the returned device secret. Because the existing model contract lacks a private human-only code channel, separate user-code prompts and secret-bearing links are unsupported rather than leaked.
4. Device code, approved method metadata and request receipts are encrypted together using existing `createDesktopSecretCrypto` with the existing supplied 32-byte master key. AAD includes owner, hashed exact workspace/registration/revision/credential-generation slot and row version. Temporary encoded/decrypted byte buffers are wiped. JS strings cannot be reliably zeroed; none are logged, returned or written in plaintext. OAuth access/refresh tokens go only to existing `RemoteMcpStore.writeOAuth` custody, never this package's public views.
5. SQL CAS reserves each effect before invoking the broker or credential store. Receipts bind action, exact target and engine/chat/run/tool-call identity. Competing factories cannot both advance a reserved slot. Inflight `starting`, `polling` and `committing` records project unknown after restart, without replay. Same-ID settled retries return stored safe outcomes, with no repeated effect. Pending/slow-down can be polled only by a later explicit completion request ID after the saved interval.
6. Start expiry is conservatively measured from the reservation timestamp, bounded by the provider duration, 30-minute custody bound and human approval expiry. A token arriving after expiry is not installed. Scope cannot exceed/change the approved scope; token resource/issuer/client/endpoint are derived from the approved method.
7. Current authority is re-read outside write transactions before effects, before settlements, after provider waits and before/after credential publication. Existing lifecycle admission aborts active work on disconnect/edit/revoke. Stop aborts only the exact registration slot, clears its pending secret and persists cancelled or unknown. A possibly executed poll/credential write stays unknown. It never deletes or rolls back unrelated/manual/browser OAuth credentials.
8. `fallback`'s internal connected acknowledgement always goes through the existing backend's **real probe** before model-visible connected/tool names. Passive `inspect` does not probe; a committed credential is conservatively projected pending until the backend probes it. It cannot fabricate tools/readiness.
9. No hidden polling/timers, network, cleanup effects, token refresh, credential install or continuation on construction, status reads, mount or restart. Local custody construction does not initialize schema. An explicitly requested operation may expire a record; observation only projects expiry.

Bounds: 30-second operation signal; 1,800-second maximum pending lifetime; 65,536-byte private record/response; 8,192-character tokens/device code; 64 effect receipts per slot; 32 slots and active operations per owner/workspace; poll interval 1–60 seconds, slow-down capped at 60. Reaching a bound refuses, never evicts unknown effects.

## Root wiring, in order

These are unapplied fragments for root-owned files. Do not activate the last fragment until the missing approved-method and broker authorities exist and have been reviewed.

### 1. Additive canonical database migration

Import `desktopMcpDeviceCustodySchema` from `./mcp-device-custody/store` in the root-owned desktop migration/bootstrap module. Allocate its next version normally and run the exported SQL in that migration's existing transaction. No existing shipped migration is edited. The table references the existing local agent row; no private engine/guest database is opened. Root must verify previous-version upgrade and the existing fresh-workspace path.

### 2. Exact human method authority — missing central dependency

Bind this exact function type from `CanonicalDeviceCustodyBinding['approvedMethod']`:

```ts
import type { CanonicalDeviceCustodyBinding } from './mcp-device-custody/binding'
type ApprovedMethodReader = CanonicalDeviceCustodyBinding['approvedMethod']
```

The reader must load a real human device-method approval in current canonical custody. It must return `null` when no such approval exists; it must not write an approval while reading. The returned `approval` must satisfy `deviceApprovalSchema`. Its immutable `approvalId`, method fingerprint, source request, immutable registration, revision, credential generation, workspace/coworker/chat and expiry must be checked against the current authority. `check()` must synchronously fence that snapshot and `signal` must abort on approval withdrawal, Stop, owner/session/workspace replacement and credential-generation change. Calls are authenticated active-run operations, not model-supplied approval IDs. Explicit continuation in a later run of the same chat is allowed only if this current authority validates that run and the still-valid human approval.

Existing `desktop_mcp_sign_in_attempts` contains browser `connect`/decline, not the required approved device method; no safe SELECT can currently establish this extra approval. Root must design the narrow human decision extension, preserve its current receipts and expose its reader. This lane deliberately does not add a second approval system or write those existing tables.

### 3. Broker authority — missing central dependency

Consume `NonNullable<CanonicalDeviceCustodyBinding['broker']>` exactly. `start(method,signal)` returns only the strict `deviceStartSchema` shape; `poll(method,deviceCode,signal)` makes **one** approved exchange and returns only `devicePollSchema`. Both must abort/drain their exact requests; bound raw response bytes before JSON parsing; validate current network/credential authority, public pinned addresses/TLS, resource/issuer metadata and reject redirects. No upstream hardcoded client/scope, arbitrary fetch, hostname override, credential forwarding or fallback between auth systems. No actual broker is provided/activated here because the current browser-PKCE network authority does not establish this device flow. Missing broker returns unsupported without reserving a row or calling anything.

### 4. Construct once in the existing MCP service lifetime

Inside root-owned `mcp-binding.ts:createService`, after the existing authority/store/runtime exist and after the migration, use the following typed constructor. `approvedMethod` and `broker` below are **required unimplemented central dependencies from steps 2/3**, not success stubs:

```ts
import { bindApprovedMcpDeviceCustody } from './mcp-device-custody/binding'
import { digest } from './mcp-device-custody/model'

const workspaceId = digest([
    'desktop-mcp-device-workspace-v1', runtime.installId ?? null,
    runtime.workspaceId, runtime.dataRoot,
]) // runtime is the existing validated DesktopRuntime, not request data
const deviceCustody = bindApprovedMcpDeviceCustody({
    db, key: masterKey, workspaceId,
    service: { store, runtime: remote, authorizeRun, shutdownSignal: entry.shutdown.signal },
    watchOwner: owner => watchDesktopMcpOwner(runtime, owner),
    approvedMethod, broker,
})
// Add deviceCustody to the existing createService return value.
```

The human approval reader must use this same stable workspace identity, not SQLite's local row `1` alone, an engine ID, loopback origin or launch nonce. The validated runtime includes installation/workspace/data-root confinement. Do not instantiate per HTTP request; use the existing service lifetime. Do not create a second global MCP pool.

### 5. Opt-in route extension; unchanged behavior when omitted

In root-owned `apps/engine/src/desktop/mcp-login-tools/route.ts`, add the optional port and resolve it after existing authentication/body/service validation:

```ts
import type { ApprovedDeviceFallback } from './backend.ts'

// Add inside McpLoginRoutePorts<Runtime>:
device?: (
    runtime: Runtime, service: RemoteLoginService, signal: AbortSignal,
) => Promise<ApprovedDeviceFallback | undefined>

// Replace only backend construction in the existing try block:
const device = ports.device
    ? await abortable(ports.device(runtime, service, signal), signal)
    : undefined
signal.throwIfAborted()
const result = await createDesktopMcpLoginBackend(
    service, owner => ports.watchOwner(runtime, owner), device,
)(raw, signal)
```

In root-owned `apps/ui/lib/desktop/server/mcp-login-binding.ts`, once `deviceCustody` is an existing service field, add:

```ts
device: async (runtime, _service, signal) => {
    signal.throwIfAborted()
    const service = await getDesktopRemoteMcpService(runtime)
    signal.throwIfAborted()
    return service.deviceCustody.fallback
},
```

No route/path, request DTO, tool registration, grant, provider admission or model-rendering change is needed. Keep existing body/response bounds, authentication, fixed errors, no-store headers, final registration guard and live probe. `binding.dispatch` is also ready for a trusted caller that already owns those route guards; do not expose it as an unauthenticated new route.

### 6. Stop/revoke/delete/shutdown

The existing MCP lifecycle admission already aborts active effects when that lifecycle invalidates. Root's canonical human-attempt cancellation/revocation must also call and await `deviceCustody.stop(exactApprovalSnapshot)` to erase waiting device data and persist the terminal/unknown receipt. It must retain the exact snapshot for repeatable cleanup even after current active-run authorization ends. The caller is trusted lifecycle authority, not a model endpoint. Repeating cleanup for that snapshot is safe; cleanup failure is not success.

Call `deviceCustody.dispose()` when removing the runtime registry entry. Shutdown signal already aborts in-flight work and stops admission. Waiting encrypted records may remain for an explicit post-restart reconciliation; neither constructor nor restore replays. Never indiscriminately delete another registration's pending data or the shared OAuth table. Root should fence copied/replaced workspace identity before exposing saved custody.

## Recovery and limits

| State/event | Custody result/recovery |
| --- | --- |
| No method approval | approval_required; no row/effect. |
| Approved method, broker absent | unsupported; no row/effect. |
| Definitive start response | encrypted waiting; bounded public approved URL only. |
| Definitive authorization_pending / slow_down | saved interval/receipt; another explicit completion ID may poll. Same ID does not. |
| Provider start/poll timeout, malformed response or lost ACK | unknown; no retry under the same slot, including new call IDs/restart. |
| Waiting expiry | failed; no exchange; device secret erased on an explicit operation/Stop. Passive inspection does not write. |
| Revocation/Stop during possibly executed effect | unknown, no late credential dispatch from an aborted provider response. Cannot promise remote cancellation. |
| Stop while waiting | cancelled, exact pending secret removed; sibling records untouched. |
| Credential store ACK lost / settlement ACK lost | no repeat token exchange or credential write. Existing committed credential is preserved; record is unknown or a committed connected receipt. Backend still probes before claiming ready. |
| Restart with starting/polling/committing | unknown projection; no automatic transition/exchange. |
| Restart with waiting | passive restore; explicit authorized completion can advance after interval and before expiry. |
| Corrupt/missing storage/key | error/refusal; never treated as a fresh anonymous attempt. |
| Different approval in the same exact slot | unknown/refusal; this package does not reset a previous attempt or discard its tombstone. |

There is no automatic token refresh, remote revocation request, browser opening, user-code display, OAuth discovery, separate auth-system support, SSE/stdio fallback or legacy plaintext pending-file import. In particular, only the credential fields supported by the existing MCP encrypted store are committed. No new permission or credential store is introduced for live access/refresh tokens.

Terminal/unknown custody is deliberately not evicted/reset. A new approval for the same unchanged revision/credential-generation cannot silently replace it. Root needs an explicit reconciliation/retirement policy before repeated brand-new attempts in that slot; bounds fail closed meanwhile. Changing registration revision/generation requires new exact approval, not replay. This is a real activation limitation, not a reason to erase unknown effects. Archive/portable export exclusion of the new app-owned table is a root integration responsibility; no share/export behavior was edited.

## Authored offline regressions and root QA

`custody.test.ts`: real in-memory SQLite and real AES-GCM with synthetic keys; start/complete; encrypted pending/metadata and redacted views; same-ID/remount recovery; observational expiry; no approval/broker; altered owner/engine/chat/revision/resource; unsupported methods/secret links; malformed/oversized payloads; competing factories; lost start/poll/credential ACK; intervals and slow-down; expiry including delayed start; Stop/revoke/edit/shutdown races; credential generation changes; sibling isolation; copied ciphertext; missing/corrupt storage; changed action with the same effect ID.

`binding.test.ts`: existing real encrypted MCP store and existing login backend; actual reported probe names; failed probe preserves credentials without announcing connection; foreign workspace/registration refusal; missing explicit approval; inactive run; manual bearer remains separate.

All regression sources are **authored and unrun**. No fixture executes outside a root-invoked test. No real endpoint or account in fixtures. Root should run targeted/full suites, types/build, previous-schema migration and route no-authority controls. For Mac board QA, first confirm the unbound path still refuses device start and ordinary Connect/manual bearer remain unchanged. Once the missing method/broker are independently bound, use an explicitly approved supported fixture method: inspect approval, start once, verify no secrets in transcript/status/logs, confirm actual tools only after the live probe. Delay start/poll/commit and Stop, revoke, switch chat/workspace, edit/delete registration; no late publication/automatic retries. Full cold restart from waiting/ambiguous/committed phases must preserve identity and receipts without any broker activity until an explicit allowed action.

## Delivery status

Implemented: local encrypted attempt custody, receipt/CAS lifecycle, exact authority adapter, original public contract reuse, canonical credential installation adapter, bounded safe outcomes and offline regression sources.

Dependent: root migration, explicit human device-method authority, validated broker, route/lifetime/cancel mounting, root execution and installed acceptance.

Unsupported: separate user-code/secret-link methods, automatic replay/refresh/reset, unrelated authentication systems and live credentials. No hooks were bypassed; normal local implementation commit completed with no hook blocker. No accounts, installed app, live data, guest state or permissions were accessed.
