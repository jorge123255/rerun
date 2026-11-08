# TL06 / FX02: guarded MCP tools and subscription admission

Source handoff only. No checks executed, no installed acceptance, no push or PR. **FX02 and HTTP inventory are ready for root composition; device-code fallback remains WAITING on an authoritative human decision and encrypted pending-device custody.** Registering a refusal under an original tool name is not completion of device login.

## Frozen identity

- Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-mcp-login-tl06-fx02`
- Branch: `desktop/next-mcp-login-tl06-fx02`
- Starting HEAD/branch/clean status verified before editing: `8297fe6404caa114dcb0c2cd6006291a8abb2038` (`desktop/finish-cloud-base-20261106-8297fe64`).
- Implementation: `3f9404096c17fe219451a0b1da85f0e857277613`.
- Scope correction: `b70b6cd8feeeb2d0f44e344fe266f78fcaef806e` (empty inventory explicitly means HTTPS registrations, not all local programs).
- This document is committed separately. Its commit is the final delivery tip, reported in the final response; use `git rev-parse HEAD` to identify it without a self-referential document hash.
- Read-only original: `2a57fa6dd53311f763bfc9abde85997b7f7e5309`.
- Read-only supplement: `ab3def9bfcf545cc9548f99c63c2b011ca094023`.
- Canonical available dependencies are source at the frozen base. No finish-seven, RD37/RD38, PR1–7 or unfinished cloud contracts copied/cherry-picked. No rebasing onto cloud714.

## Original mapping and necessary Mac adaptations

At the original pin:

- `apps/engine/src/tools/builtin/self.ts::selfTools`: `mcp_login`, `mcp_login_complete`, `mcp_status`, plus initial instruction to use `request_mcp_sign_in` before fallback. Preserve original tool names, ordering, verification-link/completion wording and prefixed model-tool inventory.
- `apps/engine/src/tools/mcp-auth.ts`: device discovery, authorization, pending file, polling and token persistence. Original discovery uses the protected-resource metadata and advertised device hint; it is not a general fabricated OAuth host. The supplement retains the same original login/completion surface.
- `apps/engine/src/tools/builtin/hitl.ts::mcpSignInTool`: existing human sign-in handoff and end-turn semantics.
- `apps/engine/src/tools/builtin/self.mcp.test.ts`: original missing registration, stdio refusal, pending/completion and live inventory behavior.

The Mac already has `desktop/mcp-sign-in/request-sign-in.ts`, its authenticated bridge/source parser and a durable human Connect card/runtime under `apps/ui/lib/desktop/server/mcp-sign-in/**`. The engine registry builds that tool. `agents/providers.ts` filters both Claude and Codex bridges against `desktopRerunToolCatalog` or branded dynamic adapters. The tool is absent from the catalog and is not dynamic-MCP branded, so both filters drop it. This is a confirmed source seam, not a live reproduction.

The Mac's existing `mcp/store.ts` owns encrypted OAuth credentials and registration revisions; `mcp/oauth-loopback.ts` owns public PKCE/loopback OAuth; `mcp-binding.ts` owns authenticated owner/run/workspace checks, invalidation and canonical transport. This package reuses those authorities via a structural concrete adapter and never changes the human card or continuation source.

**Why the original device implementation is not directly mounted:** it writes plaintext pending/token files, uses global fetch without the Mac destination/deadline/cancellation boundary, and accepts a subsequent model call as completion. The existing Mac encrypted store has a PKCE token bundle, not a durable pending-device decision/receipt adapter. A declined Connect card is not approval for fallback. There is no canonical affirmative fallback decision to read in this base. Calling the original helpers from the Mac would create a competing credential/authorization path. No second OAuth stack, plaintext custody, Composio broker or invented approval was added.

Evidence read: next-seven `CHECKLIST.md` and `WORKTREE-MANIFEST.md`, root `desktop-parity-full-register-20261106.md` and its tool-coverage sibling. These record TL06/FX02, not acceptance.

## Changed inventory

Only these new owned files:

- `apps/engine/src/desktop/mcp-login-tools/contract.ts`: strict local request/public result schemas, fixed authenticated callback path and verification-link syntax guard.
- `admission.ts`: owner/name-bound actual-instance admission; names alone do not brand a remote object.
- `tools.ts`: model-facing tools, existing human sign-in factory composition, live grant checks and authenticated callback.
- `backend.ts`: real existing remote store/probe adapter; explicit optional approved-device authority, absent by default.
- `route.ts`: complete bounded authenticated HTTP adapter, with device effects intentionally unbound.
- `index.ts`: package-local exports, not a central barrel.
- `backend.test.ts`, `tools.test.ts`, `route.test.ts`: authored unrun regression sources.
- `docs/desktop-next-mcp-login-tl06-fx02-handoff.md`.

No central catalog/provider/prompt/registry, existing OAuth/presenter, schema/migration or other owner's source was edited.

## Contracts and behavior

```ts
MCP_LOGIN_BRIDGE_PATH = '/api/desktop/internal/mcp-login'
MCP_LOGIN_TOOL_NAMES = ['request_mcp_sign_in', 'mcp_login', 'mcp_login_complete', 'mcp_status']

createDesktopMcpLoginTools(identity: LoginIdentity, runSignal: AbortSignal, port: LoginToolPort): ToolSet
desktopMcpLoginTools(ctx: RunContext): ToolSet
isDesktopMcpLoginTool(tool: unknown, name: string, owner: string): boolean
createDesktopMcpLoginBackend(service: RemoteLoginService,
    watchOwner: (owner: string) => () => void,
    device?: ApprovedDeviceFallback): (raw: unknown, signal: AbortSignal) => Promise<LoginResponse>
createDesktopMcpLoginRoute<Runtime>(ports: McpLoginRoutePorts<Runtime>):
    (request: Request) => Promise<Response>
```

`LoginIdentity` is exactly `{engineAgentId,sessionId,runId}`. The authenticated UI runtime determines workspace/local owner; none is accepted as a model-supplied override. Requests contain trusted identity, toolCallId and action `status`, `start` or `complete`; named actions accept only registered name. Strict schemas refuse URL, headers, token, command, approval, revision and arbitrary fields. Tool call/run identity is supplied by the runtime, not by the model schema.

Status uses the existing HTTP MCP probe. Metadata/credential presence never yields connected. It returns public name/revision/transport, status, bounded prefixed tool names and fixed reasons. Probe failure stays failed with zero advertised tools, not an empty successful list; later independent rows can still be inspected. Reconfiguration/revoke/Stop/owner change refuses stale results. Failure details, URLs, headers and token material are not returned in inventory. The actual existing probe may refresh its canonical OAuth credential; this adapter does not perform separate refresh or authorization.

The default route **has no device port**. `mcp_login` returns explicit unsupported and directs to `request_mcp_sign_in`; `mcp_login_complete` returns no pending fallback. It neither aliases the human HITL acknowledgement under another tool name nor fabricates a completed sign-in. Existing human request tools are composed unchanged and branded for subscription admission.

## Exact root composition fragments

### 1. Registry: use the composed factory once

In `apps/engine/src/tools/registry.ts`, replace the existing `desktopMcpSignInTools` import and corresponding `Object.assign` only:

```ts
import { desktopMcpLoginTools } from '../desktop/mcp-login-tools/tools.js'
```

```ts
Object.assign(tools, desktopMcpLoginTools(ctx))
```

Keep the existing early Foreman/delegation/setup gates and subsequent collision checking. Do not additionally assign the old factory or register upstream `selfTools`; the composed factory includes the original Mac human tool. It returns no tools when missing an active cancellable run, ephemeral, disabled or MCP permission off. Every new tool also rechecks current `mcp` permission around the callback. Human tool delivery keeps its existing live source/registration checks.

### 2. Both subscription-provider filters

In `apps/engine/src/agents/providers.ts`:

```ts
import { isDesktopMcpLoginTool } from '../desktop/mcp-login-tools/admission.js'
```

In **both** `createClaudeModel` and `createCodexModel` existing desktop `Object.entries(...).filter` predicates, add this disjunct next to the existing MCP dynamic-tool branch:

```ts
|| grants.mcp && isDesktopMcpLoginTool(tool, name, agent.id)
```

Do not remove existing filters or admit a name-only arbitrary object as a dynamic tool. This admits actual owner-bound instances produced by the composed factory. It does not enable `mcp_register`, subprocess access, shared credentials or native shell.

### 3. Catalog entry (same existing `mcp` grant, default unchanged)

In root-owned `packages/contracts/src/desktop-tool-grants.ts`, replace only the existing MCP row with:

```ts
supported('mcp', 'Custom MCP servers',
    'Use this coworker’s configured HTTPS MCP servers, inspect their status, and ask you to sign in. Device-code fallback requires a separately approved desktop adapter.',
    'request_mcp_sign_in', 'mcp_login', 'mcp_login_complete', 'mcp_status'),
```

This is the same existing grant, no enum/migration or default-on change. Handler descriptions and unsupported results must remain truthful until device custody is supplied. The branded filter fragment above also protects the admission seam when root composes catalog metadata at a different time.

### 4. Existing end-turn prompt

In `apps/engine/src/agents/systemPrompt.ts::turnClosers`, replace only the current `request_mcp_sign_in` condition:

```ts
request_mcp_sign_in: desktopApp()
    ? agent.config.enabled && !agent.config.ephemeral && hasDesktopToolGrant(agent.config, 'mcp')
    : selfImprovement.enabled,
```

Retain the existing HITL names, order and human Connect card. No new closer for login/status: these are ordinary result tools. The original `request_mcp_sign_in` remains the action which ends the turn and gives the user control.

### 5. Authenticated local route (concrete available binding)

Root adds `apps/ui/lib/desktop/server/mcp-login-binding.ts` using the existing runtime/auth/service, not engine-private imports into an inference worker:

```ts
import 'server-only'
import { createDesktopMcpLoginRoute } from '../../../../engine/src/desktop/mcp-login-tools/route'
import { authenticateDesktopEngineRequest } from './auth'
import { getDesktopRemoteMcpService, watchDesktopMcpOwner } from './mcp-binding'

export const handleDesktopMcpLoginBridge = createDesktopMcpLoginRoute({
    authenticate: authenticateDesktopEngineRequest,
    service: getDesktopRemoteMcpService,
    watchOwner: watchDesktopMcpOwner,
})
```

The path resolves from `apps/ui/lib/desktop/server` to the sibling `apps/engine` source. If root's bundler disallows that existing monorepo seam, move only the route/backend adapter into a root-owned server module while consuming the same DTO; do not import Next modules into the engine. No new dependency is required.

Root adds `apps/ui/app/api/desktop/internal/mcp-login/route.ts`:

```ts
import { handleDesktopMcpLoginBridge } from '@/lib/desktop/server/mcp-login-binding'
export const runtime = 'nodejs'
export const POST = handleDesktopMcpLoginBridge
```

The engine calls the fixed path through existing `desktopInternalJson`: only authenticated loopback with engine key, no model-selected host. Route adapter authenticates before reading input/service acquisition; bounded body 8 KiB/5 seconds, 70-second outer request, backend 60 seconds and each HTTP probe 20 seconds. Reply limit is 90 KiB (client cap 96 KiB), inventory max16 registrations and 256 tool names per server. Uncooperative waits are raced against cancellation; late results never bypass subsequent authority checks. No settings mount or passive view invokes these tools.

### 6. Device fallback: exact missing authority, do not bind a fake

`ApprovedDeviceFallback` is an optional server-side authority, not model approval input:

```ts
type Target = {
    owner: string; identity: LoginIdentity; name: string; revision: string; url: string
}
type ApprovedDeviceFallback = {
    authorize(target: Target, signal: AbortSignal): Promise<{ approvalId: string } | null>
    start(target: Target & { approvalId: string; requestId: string }, signal: AbortSignal): Promise<DeviceView>
    complete(target: Target & { approvalId: string; requestId: string }, signal: AbortSignal): Promise<DeviceView>
}
```

Root must first supply a **canonical explicit human fallback decision**, encrypted pending-device custody and durable start/poll/resolution receipts, reusing existing MCP credential/registration/lifecycle authority and the original advertised device protocol. The selected decision must be bound to exact workspace/owner/session/server revision/destination and completion must require actual user confirmation. A model boolean, grant, Connect-card decline or generic approval is insufficient. No such concrete authority exists at this frozen base; it was not invented here. This is a hard missing production dependency, not a request for live account access.

A future binding must reserve the full identity+action+fingerprint before effect, reconcile same IDs without another device authorization/token exchange, persist unknown outcomes before cleanup, keep deviceCode/token/refresh material encrypted and absent from public replies, use the existing protected network boundary with metadata/destination validation, bounded polling and cancellation, and install the token into the canonical store. It must recheck prior approval/server/grant/run around waits. Never wire original plaintext `savePending`/`saveToken` or uncancellable fetch directly.

The backend forwards the trusted target, approval ID and toolCallId as requestId to that authority once per invocation. It does not implement its durable custody by pretending an in-memory map is a receipt. A claimed connected completion is replaced by a fresh canonical connection probe before publication. The default supplied route deliberately omits this optional port. Adding the port to a route before its real authority exists would be unsafe and is unsupported.

## READY / gated matrix

| Slice | Source delivered | Remaining dependency |
| --- | --- | --- |
| FX02 request tool admission | Actual-instance helper + composed existing human tool | Root applies both filter/catalog/registry/prompt fragments |
| HTTP `mcp_status` | Real canonical store/probe adapter and route factory | Root route mount, execution QA |
| SSE inventory | Visible registered row with unavailable reason; never claims connected | Separate exact SSE status/probe adapter not bound here |
| Local stdio inventory | Explicitly excluded from HTTPS status, not spawned | Separate local-program permission and status seam; not aliased to remote MCP grant |
| `mcp_login` / complete names | Strict runtime adapters, safe default refusals and approved-authority seam | Device human-decision/custody/protocol adapter **WAITING**; TL06 device login is not complete |
| Existing human OAuth | Original card, source guards and encrypted PKCE authority reused unchanged | Root installed OAuth acceptance |
| Lost ACK / Stop | No automatic retry; effect reply failure tells model to reconcile | Future device authority must retain durable receipts/unknown outcomes |
| Restart | No automatic login, probe or replay; module has no side effects on import | Existing canonical MCP restart handling; no fabricated pending fallback |

No new persistent files/tables, migration numbering, grant, key store, browser launcher or connection pool. Probes do not install packages or execute remote tools. Device effects cannot occur via the supplied default route. No blanket success if cancellation races a hypothetical future committed effect; that authority must retain committed outcome and recovery identity.

## Authored but unrun regressions

- Owner/name instance branding versus name-only forged tools and cross-owner invocation.
- Empty HTTPS inventory wording, permission denial, aborted run, late identity mismatch and strict URL/credential/command/approval rejection.
- Real-adapter fixture: live prefixed names; one failed probe does not leak its error and does not omit a later healthy row.
- Stop/revoke/server revision/owner changes refuse stale results; forged run identity rejected before probing.
- Missing device adapter never starts authorization; absent affirmative fallback approval never calls start.
- Completion metadata cannot fabricate working tools: fresh probe replaces supplied names or returns failed.
- Uncertain device receipt is forwarded once, with exact trusted request/approval identity; no local retry.
- Lost transport acknowledgement does not leak raw error material and explicitly forbids replaying authorization.
- Unresponsive callback stops waiting on parent cancellation.
- SSE metadata never becomes connected, no local process spawned.
- Route authentication before service/payload work and oversize body refusal.

These are offline source fixtures, not test execution or accepted capabilities. No tests, typecheck, lint, formatter, build, install, fixture, server, network/OAuth/provider, Keychain/live DB, UI, listener or restart check ran. Standard Git/source inspection only. Plain commits used; `core.hooksPath` unset and standard commit hooks absent at inspection. No hook-stop encountered and no hook bypass used.

Root/cloud714 owns integration, all checks/repairs and native acceptance. Risks: monorepo server import composition must be verified; status is bounded remote HTTP scope, not every MCP transport; context rechecks depend on the canonical run/workspace service; device effect/restart/refresh behavior is deliberately not implemented by the unavailable adapter. No acceptance or full TL06 claim.
