# E5 MCP OAuth with a Mac loopback callback — source handoff

Worktree `mcp-oauth-loopback`, branch `desktop/mcp-oauth-loopback`, prepared base `b428751d716efdb3c928c124921502d2a5e4e6c1`. Isolated source only. No sign-in, provider registration, discovery, token request, credential use or app execution was performed. Root integration and Mac acceptance remain pending.

## Original source references

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` using git show:
- `apps/ui/components/agent/McpOAuthAuthorize.tsx:29`, Connected at 131, Retry at 144, Connect/Waiting at 164: presentation and language.
- `apps/ui/lib/mcp-oauth.ts:127` discovery/resource metadata; :190 dynamic public-client registration; :249 PKCE/state; :256 authorization resource binding; :272 exchange resource/verifier binding.
- `apps/ui/app/api/mcp/oauth/discover/route.ts`, `start/route.ts`, `callback/route.ts`: authenticated discovery/start and server-side exchange ownership; hosted cookie callback is deliberately not imported.
- `apps/engine/src/tools/mcp-auth.ts`: stored endpoint/client identity, rotation-preserving refresh, in-flight per-agent/server serialization. Its plaintext file/device-code/hosted token authority is NOT used by this Mac path.
- Current `apps/desktop/src/main/index.mjs:117`: existing HTTPS-only external browser handler. No shell change.

Applicable CLAUDE.md/UI AGENTS.md and the installed Next route-handler guide at the supplied codex-login-build path were read. No dependencies added.

## Changed files and exported interfaces

- `apps/ui/lib/desktop/server/mcp/oauth-network.ts`: oauthHttps, publicOAuthAddress, OAuthJson, OAuthMetadata, oauthJson, discoverLoopbackOAuth.
- `apps/ui/lib/desktop/server/mcp/oauth-loopback.ts`: OAuthStatus, loopbackMcpOAuth(store,access,json?) returning start/status/credential/cancel/shutdown.
- `apps/ui/lib/desktop/server/mcp/oauth-api.ts`: loopbackOAuthApi(oauth,access), authenticated bounded POST adapter.
- `apps/ui/components/desktop/mcp/DesktopMcpOAuthAuthorize.tsx`: isolated Connect/Waiting/Connected/Retry component; HTTPS authorization link through existing shell handler, Cancel and bounded status requests.
- `apps/ui/lib/desktop/server/mcp/store.ts`: remoteMcpOAuthSchema, OAuthTokenBundle, encrypted readOAuth/writeOAuth on the EXISTING authoritative store/key.
- `apps/ui/lib/desktop/server/mcp/lifecycle.ts`: commitCredentials serializes token persistence with config writes and holds admission until cancellation rollback is settled.
- `apps/ui/lib/desktop/server/mcp/remote.ts`: optional fourth oauthCredential binding; OAuth credential selection and final credential-identity checks. Anonymous/bearer paths remain available.
- `apps/ui/lib/desktop/server/mcp/oauth-loopback.test.ts`: authored mock HTTP/DCR/token/SQLite sources for state single use, wrong state, encrypted storage, resource identity, unsupported metadata, invalidation and serialized rotating refresh.
- `apps/ui/lib/desktop/server/mcp/oauth-network.test.ts`: authored nonpublic/mapped/mixed DNS destination and HTTPS boundary sources.
- This document.

## Implemented protocol and limits

A start re-reads current exact coworker/server revision and enabled/MCP grant, invalidates prior work for that server, discovers protected-resource metadata for the exact configured HTTPS resource and one authorization issuer, then binds a temporary callback to `127.0.0.1` on an OS-assigned port. It dynamically registers a public client for that exact redirect, requests code/S256 and resource, and keeps random 256-bit state/verifier only in the server process. No callback cookie, hosted secret, public client-metadata document or custom scheme is used. Callback state is single use and bound by its closure to local owner, server revision/URL, resource/issuer, client and redirect. Callback accepts only GET `/callback` at the exact Host/port from 127.0.0.1. Wrong state/path/peer is refused without consuming legitimate state; an accepted state is consumed before exchange, including denial/issuer failure. No code/token is echoed to its plain-text browser response.

The listener expires after five minutes, stops accepting after a valid callback, and closes on lifecycle invalidation/cancel/Quit. Socket headers/requests are bounded to ten seconds, callback URL to 8 KiB. Discovery/registration start admission has a 30-second budget, callback exchange/refresh 30 seconds, each outbound HTTP request 10 seconds. OAuth request bodies <=32 KiB, JSON responses <=64 KiB, API input <=4 KiB. All metadata/registration/token network destinations are HTTPS on public port 443, without userinfo/fragment. Each network request resolves all addresses, rejects nonpublic/mapped/mixed answers, pins a validated address in the HTTPS lookup while retaining original TLS hostname, refuses every HTTP redirect, and bounds streamed bodies. Authorization-browser destination is separately public-validated; the existing shell enforces HTTPS external navigation. No provider data is treated as instructions or logged.

Supported metadata is deliberately strict: exact resource identifier, exactly one advertised issuer, exact metadata issuer, authorization/token/registration endpoints on that issuer origin, S256, code, public token endpoint authentication `none`, dynamic registration confirming the exact loopback redirect. Authorization response issuer identification must be advertised and callback `iss` must equal that issuer. Missing metadata, DCR support, issuer identification or public loopback registration is a truthful Unsupported state. There is no fallback to parent-domain discovery, borrowed Rerun clients, hosted-secret/CIMD-only providers, device-code, stdio or legacy SSE. Providers requiring nonexpiring tokens without expires_in are also unsupported. Tokens must be Bearer with finite positive expiry <=one year; resource/issuer response fields, if supplied, must agree. These compatibility restrictions are deliberate fail-closed Mac differences, not claims of universal OAuth support.

Store bundles include resource/issuer/token endpoint/client ID/access/refresh/expiry/scope, encrypted with the same desktop AES-256-GCM key and separate per-owner/server OAuth AAD. They are never returned by list/config/status/UI/history or sent to the engine as config. Config revision binding makes prior bundles inaccessible after edit, and deletion cascades. A bearer must be cleared intentionally before beginning OAuth. Runtime uses OAuth only when the same store has an applicable bundle; otherwise it preserves anonymous/configured bearer behavior. It never falls back to an expired or failed OAuth token. Before remote publication it compares the actual selected access credential against current encrypted-store identity as well as current config/grant. Cleanup likewise withholds stale credentials.

Refreshes share one per-owner/server in-flight promise. Before submitting a rotating refresh token, a durable encrypted refreshPending claim is stored. A crash, cancellation or unknown token response retains an unconfirmed claim (or removes an invalid late write) and requires reconnect; it never blindly reuses the old refresh token. Fresh resource/issuer/token endpoint metadata and current owner/grant are checked again before refresh and token publication. Credential persistence reserves the same lifecycle queue, checks cancellation/generation before and after storage, and conditionally deletes only its own encrypted late write if invalidated. Admission stays blocked until rollback settles. A stalled database operation may outlive caller cancellation; it must remain unavailable until storage cleanup settles, never be reported as completed persistence. Root must preserve the one-authority process contract below.

## Mandatory root integration before activation

Central schemas, app/shell lifecycle, route admission, grant UI and engine integration remain root-owned. None were edited or activated here.

1. Add remoteMcpOAuthSchema as a NEW additive numbered desktop database migration after remoteMcpSchema for existing and new databases. Do not edit a shipped migration. Keep this internal encrypted table outside coworker data tools. Enable foreign keys. Use the existing master key boundary; no second token store/engine token-file authority.
2. Use exactly one store, lifecycle, OAuth service and runtime in the supervised UI process. The same current access callback must resolve exact local coworker to current engine identity, reject missing/deleting/reassigned owners and return current enabled and explicit MCP grant. Never cache board permissions. Separate engine/UI processes must forward authenticated catalog/call/mutation/invalidation to THIS authority via the existing desktop MCP bridge. Independent copies are not integration.

```ts
import {remoteMcpStore,remoteMcpOAuthSchema} from '@/lib/desktop/server/mcp/store'
import {loopbackMcpOAuth} from '@/lib/desktop/server/mcp/oauth-loopback'
import {loopbackOAuthApi} from '@/lib/desktop/server/mcp/oauth-api'
import {remoteMcpRuntime} from '@/lib/desktop/server/mcp/remote'
// Root additive migration: await db.executeMultiple(remoteMcpOAuthSchema)
const store = remoteMcpStore(db,readDesktopMasterKey)
const oauth = loopbackMcpOAuth(store,readCurrentExactMcpAccess)
const runtime = remoteMcpRuntime(store,readCurrentExactMcpAccess,fetch,oauth.credential)
const oauthApi = loopbackOAuthApi(oauth,readCurrentExactMcpAccess)
// Existing management API, runner tools and desktopMcpBridge must reuse this store/runtime.
```

readDesktopMasterKey/readCurrentExactMcpAccess are REQUIRED root interfaces, not lane exports. Supplying oauth.credential only to the panel while the real runner uses another runtime is not integrated OAuth. Do not invoke upstream engine mcp-auth/deviceLogin/loadToken/withAuth as an additional desktop authority.

3. Root registers only authenticated POST `/api/desktop/coworkers/[agentId]/mcp/oauth`. Body `{name,revision,action:'start'|'status'|'cancel'}`. The service authenticatesDesktopRequest (existing session/origin restrictions), re-reads exact current owner/grant and validates revision. start returns only `{authorizationUrl,status}`; status/cancel return state/message without credentials. Do not reuse hosted `/api/mcp/oauth/*`, expose token operations or admit wildcard generic MCP routes. Ephemeral callback is handled by the local Node listener, never public root HTTP policy.

```ts
// app/api/desktop/coworkers/[agentId]/mcp/oauth/route.ts, root-owned:
export const runtime='nodejs'
export const dynamic='force-dynamic'
export async function POST(request:Request,context:{params:Promise<{agentId:string}>}) {
  return getAuthoritativeMcpService().oauthApi(request,(await context.params).agentId)
}
```

getAuthoritativeMcpService is root's binding to the single service, not a lane export. Root HTTP policy permits exactly that authenticated path/method in addition to existing narrowly permitted MCP routes. No discovery/token endpoint is called during module import or bootstrap.

4. Add the isolated authorization component to the current saved-server MCP row, keyed by current coworker/name/revision. Preserve the original panel/editor design and anonymous/bearer controls. The component uses the same Connect/Waiting/Connected/Retry language and an explicit Open authorization in browser link after start. That ordinary HTTPS target=_blank link uses the existing external-browser handler; no popup cookie or new native browser API is introduced. It does not auto-start sign-in on mount. Root must test the extra explicit browser click on Mac. Changing owner/server props invalidates pending UI completions; status polling runs only while Waiting and stops on terminal state/unmount.

```tsx
<DesktopMcpOAuthAuthorize key={`${agentId}/${server.name}/${server.revision}`}
  agentId={agentId} name={server.name} revision={server.revision}/>
```

5. Existing store.save/remove and runtime.disconnect invalidate active callback/refresh tickets. Root disable/revoke/delete transitions MUST synchronously reserve owner-wide admission across the WHOLE persisted transition:

```ts
await store.lifecycle.transitionOwner(agentId, async()=>{
  await persistCurrentEnabledGrantOrDeletion()
})
```

Reservation releases on success/failure, while old tickets stay invalid. Access must fail closed on partial/unknown writes. Disconnect alone cannot guard a pending permission write. On Quit first close HTTP/tool admission, call oauth.shutdown() synchronously (closes listeners, aborts callbacks/refreshes and terminally shuts the shared lifecycle), then complete existing runner/server shutdown. Construct a fresh service only at the next app startup. Do not start a real callback service during build, tests not explicitly authorized by root, module import or model discovery. The listener is created only by an authenticated user start.

## Validation still required

Authored regressions have NOT been run. Root must run offline source tests/type checks/lint/build, including existing anonymous/bearer MCP regressions, API authentication/status/cancel, fake short-lived listener expiry and wrong/reused state/issuer, revoke/edit/remove/disconnect/Quit during every await, late cancelled credential persistence, refresh rotation after lost responses/restart, DNS pin/redirect/body limits, and renderer navigation ownership. Root alone may run disposable real provider DCR/sign-in/token/refresh and native browser/Quit/restart checks after exact-source review. Successful status is not proof that the actual runner used a tool result.

**Checks and Mac acceptance were not run by me.** No app control, live network/model requests, sign-in, provider registration, token endpoint requests, credential use, live data changes, installs, preview, push or merge. This slice stops at source handoff; no central checklist or acceptance status changed.
