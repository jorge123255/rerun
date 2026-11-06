# Round 33 C — MCP sign-in requests inside chat

Source implementation and authored regression sources only. Root owns central integration, every repair/check, live OAuth/provider testing and installed-app/restart acceptance.

## Original source/design mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/engine/src/tools/builtin/hitl.ts`: `mcpSignInTool`, registered-name/reason input and delivered `HITL_ACK`. The desktop factory retains that end-of-turn behavior; the decision is a later user turn.
- `apps/ui/components/chat/McpSignInBlock.tsx`: `Sign in to …`, reason/custom-server subtitle, status badge, `Connect`, `Continue`, `Not now`, `Cancel`, independent cards and inline layout.
- `apps/ui/components/agent/McpOAuthAuthorize.tsx`: discovery, waiting, connected, error/retry and explicit browser authorization presentation.
- `apps/ui/components/services/CustomMcpStatusBadge.tsx`: `Connected`, `Sign-in needed`, `Unreachable` and no fabricated status/tool count.
- `apps/ui/components/services/sign-in-popup.ts`: user-gesture popup ordering. The accepted Mac adapter uses an explicit returned browser link instead of a model-triggered popup, preserving the no-arbitrary-URL boundary.
- `apps/ui/lib/chat-hitl.ts`: original `MCP sign-in result:\n- name: connected\n\nIts tools are available now. Please continue.` and `[User skipped signing in to the MCP server]` continuation text.

Also read `round32-self-mcp/docs/desktop-round32-h-handoff.md` without modifying it. This lane does not register a server, replace its configuration, create a proposal system or grant tools.

## Canonical contract and exported surface

### `packages/contracts/src/desktop-mcp-sign-in.ts`

- `desktopMcpSignInRequestInputSchema`: only registered `name` and optional 300-character `reason`; model URLs, authorization URLs, tokens and credential namespaces are rejected.
- `desktopMcpSignInSourceSchema`: exact agent/session/run/source-message/tool-call/fingerprint plus registered server `{name,revision,url,displayName,host?,icon?}`. Configuration revision is distinct from request revision.
- `desktopMcpSignInViewSchema`: pending/connecting/connected/declined/error, safe error and immutable outcome receipt.
- `desktopMcpSignInDecisionSchema`: Connect/Not now/Cancel with exact attempt and expected revision. No authorization URL or token travels in a decision.
- `desktopMcpSignInOAuthViewSchema`: adapter-only idle/waiting/connected/error/unsupported and an optional validated HTTPS authorization link.
- `serializeDesktopMcpSignInResult`: original names-only connected/declined continuation text.

### Engine

`createDesktopMcpSignInTool(authority)` exports `request_mcp_sign_in`. `authorize` performs current-run/current-permission checks. `deliver` resolves only a currently registered server with supported OAuth, persists its trusted configuration snapshot and returns the exact source. A different tool-call source refuses acknowledgement.

### UI server

- `ensureDesktopMcpSignInSchema`: additive request/attempt/receipt tables, no OAuth tokens.
- `createDesktopMcpSignInStore`: `publish`, `read`, `readBySource`, `begin`, `seal`, `fail`, `cancel`, `receipt`, `markAccepted`.
- `createDesktopMcpSignInContinuation`: `complete`, `decline`, `recover`.
- `createDesktopMcpSignInRuntimePorts`: binds current source/owner/OAuth/continuation without a parallel runtime.
- `createDesktopMcpSignInApi`: supported GET/POST binder with bounded no-store inputs and exact acknowledgement checks.
- `desktopMcpSignInAttention` and `canMarkDesktopMcpSignInRead`: exact source/server navigation and acknowledged-only read receipts.

### Client and UI

- `readDesktopMcpSignIn`, `desktopMcpSignInAction` in `apps/ui/lib/desktop/mcp-sign-in-client.ts`.
- `DesktopMcpSignInBlock`, `DesktopMcpSignInStatusBadge`, `DesktopMcpSignInReceipt`.

## Exact root wiring

### 1. Contract export and database

Add root’s normal barrel export for `desktop-mcp-sign-in.js`. After root’s agent/session tables exist:

```ts
import { ensureDesktopMcpSignInSchema } from './mcp-sign-in/schema'

await ensureDesktopMcpSignInSchema(db)
```

Root owns the migration and previous-version test. No central schema/migration/barrel was edited here.

### 2. Grant and tool registry

Register the engine factory through root’s registry. Require the current relevant MCP/sign-in permission and active run without widening it. Do not infer sign-in permission from a receipt, server configuration or tool availability.

`deliver` must resolve the model’s name against current trusted registration, require a supported OAuth flow, capture its current configuration revision and call `store.publish`. Reject removed/replaced/unsupported servers before publishing. No registration or permission mutation occurs.

### 3. Runtime ports and OAuth

Bind `createDesktopMcpSignInRuntimePorts({store,source,authority,oauth,send})`:

- `source(sessionId,signal)` reads the exact source-bound request from authenticated local history and returns `{source,name,reason?}` or null. It must reject foreign history and never resume a decision.
- `authority(sessionId).check` asserts prepared current local agent/session, enabled/not-deleting owner and current grant. Stop/deletion/revocation/config replacement fails closed.
- `oauth.start/status/cancel` adapt the existing `loopbackMcpOAuth` methods using the stored server name/revision. That adapter owns discovery, PKCE, loopback callback, token encryption and connection generation checks. Do not open model-provided URLs or expose token bundles.
- `send` is root’s provider/queue adapter with exact source and continuation request ID.

`connect` calls `store.begin` then OAuth start. `status` only reads adapter/view state. `complete` first requires fresh adapter `state === 'connected'`, then current owner authority, then seals. `cancel` invokes OAuth cancel and returns the request to pending without a follow-up.

### 4. Route files (root creates)

Create `apps/ui/app/api/desktop/sessions/[sessionId]/mcp-sign-in/route.ts` with only supported route entries and `desktopRoute` authentication:

```ts
import { createDesktopMcpSignInApi } from '@/lib/desktop/server/mcp-sign-in/api'
import { desktopRoute } from '@/lib/desktop/server/http'

export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
    const { sessionId } = await params
    return desktopRoute(request, async runtime => createDesktopMcpSignInApi(desktopMcpSignInPorts(runtime, sessionId)).GET(request, sessionId))
}
export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
    const { sessionId } = await params
    return desktopRoute(request, async runtime => createDesktopMcpSignInApi(desktopMcpSignInPorts(runtime, sessionId)).POST(request, sessionId))
}
```

`desktopMcpSignInPorts(runtime,sessionId)` is a root-owned binder returning `createDesktopMcpSignInRuntimePorts(...)`. No route implementation was added in this lane because routes are root-owned.

### 5. Provider/queue continuation

Root’s queued-turn admission must accept an MCP sign-in source guard. Use `receipt.summary` and `receipt.continuationRequestId`:

```ts
await chat(engine, agent.engineAgentId, {
    sessionId: session.engineSessionId,
    message: receipt.summary,
    desktopQueuedTurn: {
        runId: receipt.continuationRequestId,
        ...(mode === 'replay' ? { replayOnly: true } : {}),
        mcpSignIn: source,
    },
    source: 'dashboard',
})
```

The continuation adapter replays first, sends only on a replay miss and marks accepted only after exact local session/run acknowledgement. Root must not treat a receipt as tool authorization. Connected tool readiness is separately authenticated before seal.

### 6. Attention/history and chat mount

Use `desktopMcpSignInAttention(view)` for pending/Actions/Needs you and `canMarkDesktopMcpSignInRead(view,{requestId,revision})` for completion races. Pending remains true until the exact continuation is accepted, including sealed-but-unacknowledged receipts.

Mount only the exact current request:

```tsx
<DesktopMcpSignInBlock
    sessionId={session.id}
    request={request}
    active={active}
    inline
    onAccepted={response => consumeAcknowledgedContinuation(response)}
/>
```

The component does not start OAuth on mount. Connect requires a user action. Waiting polls status without sealing; fresh connected state enables Continue. Restored unacknowledged receipts offer `Retry continuation`.

## Durable/recovery semantics and supported-auth matrix

| Situation | Owned behavior | Root dependency | Unsupported |
| --- | --- | --- | --- |
| Model request | Registered name/reason only; trusted config snapshot | Current registration and permission | Model-selected URL/namespace |
| Connect | Pending/connecting, adapter link only | Existing discovery/PKCE/loopback | Arbitrary authorization URLs/popups |
| Callback/readiness | Fresh exact connected state before seal | OAuth token store and generation checks | Config existence as success |
| Not now | Immutable declined receipt and one follow-up | Continuation admission | Fabricated connected state |
| Cancel/error | Pending or honest error, retry allowed | OAuth cancellation/readiness | Forced decline or false success |
| Concurrent decisions | Exact-attempt fingerprint and one receipt | Database initialization | Duplicate completion |
| Lost ACK/restart | Sealed receipt recovers same run; UI retry | Provider replay and mount | Automatic OAuth/continuation replay |
| Attention/history | Names/source only; acknowledged-only read | Central projections | Tokens/authorization secrets |
| Auth methods | Public PKCE + dynamic public loopback registration | Existing provider compatibility | Bearer reuse, confidential clients, arbitrary OAuth |
| Verification | Regression sources with fakes only | Run all checks and disposable-provider QA | Live credentials/acceptance claims |

Additional recovery details:

- Changed registration, cross-owner source, stale expected revision and late attempt responses refuse before effects.
- Save/complete and decline serialize per request; sibling requests keep independent attempts.
- Cancel guards the exact Connect attempt and does not produce a continuation.
- A readiness/sealing failure creates no receipt. Provider failure leaves an honest retryable error.
- Accepted responses converge without replaying OAuth or sending a second user turn.

## Regression sources authored, all unrun

- `apps/ui/components/desktop/mcp-sign-in/contracts.test.ts`: forged model URLs, strict source/view/decision contracts and original summaries.
- `apps/engine/src/desktop/mcp-sign-in/request-sign-in.test.ts`: supported delivery, forged/revoked admission and foreign source.
- `apps/ui/lib/desktop/server/mcp-sign-in/store.test.ts`: readiness sealing, partial failure, concurrent decisions, denied/Cancel, changed registration, restart and siblings.
- `apps/ui/lib/desktop/server/mcp-sign-in/service.test.ts`: lost ACK, exact replay and attention completion.
- `apps/ui/components/desktop/mcp-sign-in/client.test.ts`: canonical route/envelope and exact acknowledgement.
- `apps/ui/components/desktop/mcp-sign-in/DesktopMcpSignInBlock.test.tsx`: original presentation, Connect/Cancel, Continue, Not now, restored continuation retry and invalid-link error.

No tests, typecheck, lint, builds, installs, servers, provider/network calls, UI actions, Docker, Keychain, live data or restart acceptance were performed. Installed Next.js guides under `node_modules/next/dist/docs` are absent in this checkout; no installation was attempted.

## Changed files

- `packages/contracts/src/desktop-mcp-sign-in.ts`
- `apps/engine/src/desktop/mcp-sign-in/request-sign-in.ts`
- `apps/engine/src/desktop/mcp-sign-in/request-sign-in.test.ts`
- `apps/ui/lib/desktop/server/mcp-sign-in/schema.ts`
- `apps/ui/lib/desktop/server/mcp-sign-in/store.ts`
- `apps/ui/lib/desktop/server/mcp-sign-in/store.test.ts`
- `apps/ui/lib/desktop/server/mcp-sign-in/service.ts`
- `apps/ui/lib/desktop/server/mcp-sign-in/service.test.ts`
- `apps/ui/lib/desktop/server/mcp-sign-in/runtime.ts`
- `apps/ui/lib/desktop/server/mcp-sign-in/api.ts`
- `apps/ui/lib/desktop/mcp-sign-in-client.ts`
- `apps/ui/components/desktop/mcp-sign-in/DesktopMcpSignInBlock.tsx`
- `apps/ui/components/desktop/mcp-sign-in/DesktopMcpSignInBlock.test.tsx`
- `apps/ui/components/desktop/mcp-sign-in/DesktopMcpSignInStatusBadge.tsx`
- `apps/ui/components/desktop/mcp-sign-in/DesktopMcpSignInReceipt.tsx`
- `apps/ui/components/desktop/mcp-sign-in/contracts.test.ts`
- `apps/ui/components/desktop/mcp-sign-in/client.test.ts`
- `docs/desktop-round33-c-handoff.md`
