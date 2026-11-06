# Round 33 F — account-bound catalog OAuth source handoff

Prepared branch verified clean at `b521375b9614bb798049c08baf32ecb2490e5beb`, `desktop/round33-service-oauth`. Preserved Round32 account-source commit is the branch base; it remains source under root review, not installed acceptance. No reset, switch or edits to any other worktree. E4 remains incomplete; no checklist count changed.

Read project CLAUDE.md, apps/ui AGENTS.md/CLAUDE.md and `docs/desktop-agent-assignment-standard.md`. Installed Next.js guides were absent under both lane `node_modules/next/dist/docs` and `apps/ui/node_modules/next/dist/docs`. No dependencies were installed to recover them. No Next route module was authored: route binder lives in the owned server directory and root exports supported route entries only. Root must check installed-version UI conventions during integration.

## Original source/design mapping

Actual sources inspected with `git show a6d63a4b542674ddd002e51b39ba0df6e0807bcc:<path>`:

- `apps/ui/lib/services/manifest.ts`: method kind, OAuth target/overrides, manifest skill shape and recommended method semantics.
- `apps/ui/lib/services/compiler.ts`: pending OAuth target after compilation, instance-scoped MCP names and skill footprint, secret substitution exclusions; upstream `.env` writes and cloud actions are not used.
- `apps/ui/lib/services/registry.ts`: base/additional accounts, labels/order, exact footprint and shared-skill preservation. This lane does not invent account keys or change ownership semantics.
- `apps/ui/lib/services/instances.ts`: `instanceServerName`, `ordinalInstanceLabel`, immutable instance identity. The new `oauthAccountServerName` calls the existing instance naming helper; root allocation retains the Round32 account allocator/label/order rules.
- `apps/ui/components/services/AuthMethodPicker.tsx`: reused directly, original rows/icons/labels and input order. `defaultCatalogOAuthMethod` preserves explicit existing selection, then recommended, then first; unknown explicit IDs refuse.
- `apps/ui/components/services/ServiceConfigForm.tsx`: configuration → Connect step, original small full-width outline button, Connecting…/Connect copy, and scoped instance key. Local setup keeps configuration separate from the explicit browser-opening action.
- `apps/ui/components/services/ServiceInstalledBlock.tsx`: successful readiness presentation. The shared component invalidates a hosted connector hook, so it is not mounted here; local UI retains Connected/check icon and waits for real health.
- `apps/ui/components/agent/McpOAuthAuthorize.tsx`: Discovering OAuth provider…, Connect, Waiting for authorization…, Connected, Retry states/icons. Its hosted `/api/mcp/oauth/*` discovery/popups are not imported. New local adapter UI uses the original presentation primitives with account identity and epoch checks.
- `apps/engine/src/tools/mcp-auth.ts`: token/refresh semantics and unknown rotation concerns. Native plaintext token files, device-code endpoints and provider error logging are not copied.

Current source dependencies read: account compiler/identity/install/reservation/lifecycle/wire contracts; remote `oauth-network.ts`, `oauth-loopback.ts`, `oauth-api.ts`, encrypted MCP store, account `header-secret-codec.ts`, service config UI and public service/account contracts. The installed-app external-link handler exists in `apps/desktop/src/main/index.mjs`; server-side service code currently lacks a direct approved-browser invocation adapter.

## Owned changed files

- `packages/contracts/src/desktop-service-oauth.ts`
- `apps/ui/lib/desktop/server/services/oauth/compiler.ts`
- `apps/ui/lib/desktop/server/services/oauth/ports.ts`
- `apps/ui/lib/desktop/server/services/oauth/store.ts`
- `apps/ui/lib/desktop/server/services/oauth/primitive.ts`
- `apps/ui/lib/desktop/server/services/oauth/lifecycle.ts`
- `apps/ui/lib/desktop/server/services/oauth/api.ts`
- `apps/ui/lib/desktop/server/services/oauth/oauth.test.ts`
- `apps/ui/lib/desktop/server/services/oauth/store.test.ts`
- `apps/ui/lib/desktop/server/services/oauth/primitive.test.ts`
- `apps/ui/lib/desktop/service-oauth-client.ts`
- `apps/ui/components/desktop/services/oauth/DesktopCatalogOAuthMethods.tsx`
- `apps/ui/components/desktop/services/oauth/DesktopServiceOAuthSetup.tsx`
- `apps/ui/components/desktop/services/oauth/DesktopServiceOAuthConnect.tsx`
- `apps/ui/components/desktop/services/oauth/DesktopServiceOAuthConnect.test.tsx`
- `docs/desktop-round33-f-handoff.md`

## Contract and root wiring

Root exports `desktop-service-oauth.ts` from the shared contract barrel. It is the sole public OAuth service attempt schema. No regression is placed in production contracts. No engine file uses deep contract imports; this lane contains UI/server code only.

Public POST actions are strict `desktopServiceOAuthActionSchema`:

- configure: `{action:'configure',requestId,intent,slug,methodId}` using the preserved Round32 `DesktopServiceAccountIntent` (new/additional/existing). No URL, token, headers, secret fields or supplied engine ID.
- start: `{action:'start',requestId,accountKey,expectedGeneration}`.
- lookup: `{action:'lookup',requestId}` for unknown/lost start ACK; read-only and owner-scoped.
- status/cancel/probe/disconnect: `{action,attemptId,expectedRevision}`.

All request/attempt/revision/generation IDs are UUIDs. Response is `{snapshot:DesktopServiceOAuthSnapshot}` containing only local public account/installation/method IDs, label, revision, status, expiry, configured/installed booleans and fixed messages. No authorization URL, issuer response, state, verifier, code, refresh/access token, token generation secret, engine ID, native path or metadata is returned. An attemptId is a public generation identity, not an authorization secret. Missing/expired authority returns a generic fixed 409 message.

Root-owned route mount (proposed unique local URL, not a competing existing route):

```ts
const oauthApi = serviceOAuthApi(serviceOAuth, authorizeCurrentLocalCoworker)
export async function POST(request: Request, context: {
  params: Promise<{ agentId: string }>
}) {
  return oauthApi(request, (await context.params).agentId)
}
```

Mount `/api/desktop/coworkers/[agentId]/service-oauth`. `authorizeCurrentLocalCoworker` validates authenticated local user, actual coworker and request ownership/origin. Existing `authenticateDesktopRequest` and bounded body reader are reused; root must retain existing same-origin/CSRF admission. Browser callers cannot submit raw callback payloads. The real callback remains the existing localhost listener.

Root binding construction, with the SAME existing database/key reader and account authority:

```ts
const oauthStore = sqliteServiceOAuthStore(db, masterKey)
const oauthPrimitive = catalogOAuthPrimitive(oauthAccounts, oauthStore)
const serviceOAuth = serviceOAuthLifecycle(
  oauthAccounts, oauthStore, oauthPrimitive, openApprovedOAuthBrowser,
)
await serviceOAuth.reconcile() // before admission; no network/sign-in/probe replay
```

Append `SERVICE_OAUTH_SCHEMA_SQL` as a NEW numbered root migration: attempts, per-installation encrypted token slot, and partial unique active-attempt index. Do not run DDL in routes, edit shipped migrations or open a second database. Add the central previous-version migration regression in root's migration suite. Ciphertext reuses `sealHeaderBundle` / `openStoredHeaderBundle` from preserved account source with disjoint `oauth:<installationId>` installation namespace and `configGeneration:attemptId` AAD revision. It is stored only in the new OAuth token table, not the header/Bearer table. This preserves existing credential records and the existing AES-GCM/key source. Never log codec arguments, ciphertext, plaintext bundles or errors containing provider payloads.

## Exact account authority dependency (not implemented by a cast)

`OAuthAccounts` in `oauth/ports.ts` is an adapter over the SAME canonical service accounts, not a second account registry:

```ts
catalog(slug): Promise<ServiceManifest|null>
configure(owner, requestId, intent: DesktopServiceAccountIntent,
          plan: CatalogOAuthPlan, signal): Promise<OAuthAccountBinding>
current(owner, accountKey, signal): Promise<{
  binding: OAuthAccountBinding; enabled: boolean; granted: boolean; healthy: boolean
}>
exclusive<T>(owner, installationId, work:()=>Promise<T>): Promise<T>
readiness(binding, credential:()=>Promise<string>, signal): Promise<{healthy:boolean}>
disconnect(binding, signal): Promise<void>
```

Binding fields: `{owner,engineId,installationId,accountKey,label,methodId,configGeneration,endpoint,transport:'http',catalogFingerprint,serverName}`. `configGeneration` is the canonical account row's UUID revision; `endpoint` maps to canonical plan `url`, `methodId` to plan `methodId`. Current root account row MUST explicitly have `plan.shape === 'oauth'`; a header/Bearer/anonymous account cannot be projected through this port. The existing Round32 `AccountCompilePlan.shape` and public account view currently permit only anonymous/bearer/headers and reject OAuth. Root must add the explicit OAuth variant at that shared seam and provide this projection; this lane deliberately does not pretend an anonymous row is OAuth or overwrite header credentials. Existing non-OAuth accounts continue through their original compiler/lifecycle/store. Existing-intent OAuth configuration is refused if its method/catalog fingerprint/generation changed. Changing credential families requires a separate explicit root account operation.

`configure` must call the preserved allocation/reservation machinery with the exact request ID, base/additional keys, 64-account bound, multiInstance policy, immutable installation ID and ordinal labels/order. Use `oauthAccountServerName(plan, instanceId)` for MCP names and canonical skill ownership by installation. Write a pending/preparing OAuth configuration without credentials, health, tools or grant changes; same-request retries reconcile the same row/revision. Bind the plan fingerprint and prevent catalog drift before commit. For existing accounts, verify expected revision, OAuth shape and slug/key relationship; reject sibling/foreign family requests. Never touch a header bundle/Bearer column to implement OAuth.

`exclusive` must be the actual shared account/owner mutation gate, including old service endpoints, remove/reconfigure and callback/refresh writes, not a new OAuth-only mutex. It must not retain a lock while invoking a reentrant readiness credential callback: readiness performs network work with current-generation checks and reacquires the gate only for commits. The partial unique SQLite index provides a durable backstop against two live sign-ins for one installation.

`readiness` must use G/root's exact HTTPS account transport, inject the credential internally and ONLY into that account's headers/request, enforce redirect/resource/owner/run/current Apps-grant checks, reject tool-name collisions and publish/verify required bundled skills through canonical `skill-journal` ownership. Return healthy only after real authenticated discovery and all required skills are acknowledged. Preserve another account's resources and edited/private user skill directories. Set canonical row ready/current health/launch and tool names atomically with current-generation admission. `current.healthy` reflects fresh existing canonical health and launch; a stale saved connected attempt is moved to checking when polled. Do not render `installed:true` from token existence alone.

`disconnect` must clear canonical health/tool availability and invalidate its generation while retaining/removing only exact owned resources according to the existing account disconnect/remove distinction. Header/Bearer sibling credentials and private skills remain untouched. It does not contact a provider revocation endpoint.

Root's before-reconfigure/remove/owner-delete/grant-revoke hooks must call `serviceOAuth.invalidateAccount(owner, installationId)` while holding the SAME account/owner transition authority, BEFORE replacing/removing the canonical row. This hook persists cancellation, closes only that account's listeners/refresh scopes and deletes exact generation tokens, including tokens left by a failed readiness attempt. Never run it for a sibling installation. Root still owns exact skill cleanup and any engine catalog removal. Shutdown calls `serviceOAuth.shutdown()` before closing the store; all loopback scopes close, and restart marks uncertain attempts rather than launching sign-in again.

## Approved-browser dependency

`ApprovedOAuthBrowser = (url:string, signal:AbortSignal)=>Promise<void>` is server-only. Root must bridge the existing approved external-link mechanism to this operation, rechecking current attempt/permission and HTTPS policy immediately before opening. Existing discovery `publicOAuthAddress` is used before calling this port. Do not implement it with a shell command or send authorizationUrl/state through normal chat, renderer snapshot, logs, templates or history. No approved-browser call exists in this lane until root supplies that adapter; this is a concrete missing authority, not a placeholder success.

## Security, cancellation and refresh

`catalogOAuthPrimitive` reuses `loopbackMcpOAuth`, `discoverLoopbackOAuth`, public destination checks, PKCE S256/state, one-use loopback callback, exact localhost Host/path/address, issuer/resource validation, dynamic registration and encrypted refresh/refreshPending protocol. Its virtual connection adapter is bound to one installation alias and exact config generation. It does not insert a custom remote MCP connection or enable remote-MCP grants. Primitive state/verifier/redirect stay inside the existing primitive's attempt closure. Every token commit is gated by live account authority and a SQL existence check for exact canonical owner/installation/engine/revision/shape/endpoint/method plus live attempt state.

A successful callback only reaches checking. Explicit Check connection invokes readiness; only healthy readiness reaches Connected/installed. Probe intent is persisted before network work. Unknown readiness acknowledgement stays interrupted and does not silently replay; explicit reconnect remains available. Cancel/expiry persists invalidation before closing callback and deleting exact token generation. A late callback cannot revive a cancelled/deleted/replaced account; old-generation clears cannot delete a newer generation's token. An old dialog cannot cancel/disconnect while a newer live attempt owns the same installation. Start request replay returns the recorded attempt without reopening the browser. Refresh remains inside the existing primitive's single-flight generation; cancellation-aware encrypted writes restore only the ciphertext displaced by that exact write, preserving an uncertain refreshPending marker instead of silently retrying rotated credentials.

Restart performs no discovery, sign-in, browser launch, authenticated probe or refresh. Saved token + no uncertain refresh/probe ACK becomes checking for an explicit check, retaining encrypted token generation. Missing/corrupt/pending tokens or uncertain probe state become interrupted. Interrupted sign-in without a saved token requires an explicit new start request. Attempts are revision-checked and owner-scoped. List/reconciliation reads refuse over 2,048 retained records; root needs a retention policy preserving necessary identity tombstones, rather than silent truncation/replay. Sign-in expiry is 5 minutes, local action deadline 45 seconds, existing primitive discovery/refresh deadline 30 seconds. Body max 8 KiB and strict schemas bound caller-supplied IDs.

## UI integration

Use the original method order/labels from service detail. Merge `catalogOAuthMethods` ONLY into OAuth rows; retain the preserved account adapter's availability for anonymous/Bearer/custom-header rows. Managed/Composio/paid/stdio/SSE remain unavailable. `DesktopCatalogOAuthMethods` reuses original `AuthMethodPicker`, refuses unknown/unsupported selections and exposes a reason. Root routes selected OAuth methods to `DesktopServiceOAuthSetup`, other supported methods to the existing account form. A single method uses the original recommended/default selection and goes straight to its config view.

`DesktopServiceOAuthSetup` uses the existing `DesktopServiceAccountIntent`, saves a pending configuration with a stable request ID, then mounts `DesktopServiceOAuthConnect`. The explicit second Connect opens the approved browser; this deliberate local adaptation keeps pending configuration distinct from sign-in and never mounts the original hosted OAuth children. The component keys by coworker/account/installation/config generation, aborts old read requests and drops late results on owner changes. It preserves original Connect, Connecting…, Waiting for authorization…, Connected, Retry, Cancel and Disconnect presentation/icons with responsive wrapping; no board/chat/navigation component changed. Status polling is read-only while waiting and never begins sign-in from an effect. Closing/unmounting stops local reads; explicit Cancel invalidates the server attempt. Lost start ACK can be reconciled by lookup before cancellation, without spawning a second login. No localStorage, token fields, URL/popup state, secret echo or grant changes.

Root must keep the board/chat mounted and preserve selected account label/order. Opening Apps or a settings panel should show current saved configuration without starting a listener or probing. Only explicit Connect/Check connection invokes those effects. Existing main-process external-link policy, root registry exposure, engine transport credential injection, template exclusions and central exports remain root-owned.

## Matrix and regression sources

| Capability | Source status | Remaining dependency/limit |
| --- | --- | --- |
| Declared public PKCE OAuth catalog plans | Implemented | Exact one HTTPS Streamable HTTP server; no ignored overrides |
| Durable attempts and encrypted token generations | Implemented | Root new migration on existing DB/key source |
| PKCE/loopback/callback/refresh | Adapter implemented | Reuses existing primitive, no new OAuth protocol |
| Pending configuration and immutable account identity | Root dependent | Existing core needs explicit OAuth shape and exact projection |
| Authenticated readiness and owned skills | Root dependent | G/root transport and canonical skill ownership adapter |
| Connect/Cancel/retry/local UI | Implemented adapters | Root method routing, account mounting and approved browser bridge |
| Restart/lost ACK/stale callback | Implemented source | Root before-change/shutdown hooks and execution validation |
| Client-secret/static-client/declared-scope/issuer overrides | Unsupported | Existing primitive cannot enforce these requirements; methods explicitly unavailable |
| Region/input-templated/query/header OAuth setups | Unsupported | No silent substitution or credential-family reinterpretation |
| Managed/Composio/paid backends/device-code/SSE/stdio | Unsupported | No hosted account/backend activation |
| Provider revocation | Unsupported | Disconnect clears local credentials only |

Authored and UNRUN:

- `oauth/oauth.test.ts`: declared method/order, hostile catalog URLs, unsupported override refusal, configuration without sign-in/grants, explicit readiness, owner/generation isolation, stale Cancel, restart token preservation without replay, unknown probe ACK, same-start replay, denial/expiry and cancelled late status.
- `oauth/primitive.test.ts`: exact account alias/revision binding, wrong owner and stale generation refusal, removed-authority token-write refusal.
- `oauth/store.test.ts`: encrypted codec/AAD isolation by owner, installation namespace and token generation, independent schema footprint.
- `DesktopServiceOAuthConnect.test.tsx`: no automatic sign-in and late result drop on coworker change.

Existing `mcp/oauth-network.test.ts` / `oauth-loopback.test.ts` remain the protocol regressions for hostile discovery/redirects, PKCE/state/issuer callback mismatch, refresh rotation/lost ACK and restart. They were read/reused as dependencies, not executed or edited. Root should run them plus new account bridge scenarios, real SQLite cancellation/refresh races, removed installation during callback, sibling refresh/disconnect, owner revoke during browser handoff, owned-skill cleanup and full Mac/restart acceptance.

No tests, typecheck, lint, builds, installs, app servers, live API/provider/login/browser, credentials/Keychain, installed app, Docker, packaging or network service actions were run. No push/merge/deploy/publication. Root reviews/fixes/integrates and executes every check. Source handoff is not installed acceptance or E4 completion.
