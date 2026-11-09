# G — Approved MCP device broker boundary

## Result and authority gap

The existing custody binding already accepts an exact current device-method approval and forwards it to its injected broker. The mounted Mac human approval cannot produce that approval: Connect records a browser OAuth decision for a server snapshot, and calls `service.oauth.start`. It neither reviews nor persists a device method, client, scope, credential generation or device-specific expiry. Discovery does not provide human consent.

Activation remains gated. This delivery expands the existing fake-broker binding regression source and records the exact production prerequisite. It adds no runtime code, network broker, human approval system, route, migration, registry, model tool or credential store. The fixture's synthetic approval is deliberately injected at the existing authority port; it is not evidence of a mounted human device approval.

## Verified coordinates

- Fork: `jorge123255/rerun`; existing local Git objects, no fetch or live service.
- Base retained from the preceding finish-pin instruction: `7080add37a60bd604965649319143b8211818fd9`.
- Base tree: `e7db3a3f5df8057ffe86576153a8acff3360481b`, matched before editing.
- Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-g-approved-mcp-broker`.
- Branch: `desktop/next-g-approved-mcp-broker`.
- Both requested lane path and branch were absent before creation; the new checkout was clean at the exact base before edits.
- Regression source commit: `f345313b603e45273776babc8a97d689d255ec20`.
- Source parent: `7080add37a60bd604965649319143b8211818fd9`.
- Source tree: `61581de736b6ed98578575050c68feab4d507570`.
- Final delivery is the following documentation commit; its full SHA, parent and tree are reported from Git with delivery.

Older custody, import and other worktrees were preserved. No ownership, permissions, accounts, guest state, installed app or environment settings were changed. Only normal local commits were used. The configured hook directory contains sample hooks only; no hooks were bypassed and no checks were triggered.

## Changed paths

1. `apps/ui/lib/desktop/server/mcp-device-custody/binding.test.ts` — extend the existing real encrypted SQLite/remote-MCP-store fixture, fake approval reader, fake broker and real login backend. Regression source only, unrun.
2. `docs/desktop-next-g-approved-mcp-broker-handoff.md` — this handoff.

## Original comparison

Original reference: `rerun-build/rerun` dev `c33c020ffb33263ec29de6f76d9b269bca786d90`, tree `b1a34b46b40abeb1ffe8156a0c9fe0cb0ac3fd90`, inspected from local Git objects.

- `apps/engine/src/tools/registry.ts:52`: mounts `selfTools` when self-improvement is enabled.
- `apps/engine/src/tools/builtin/self.ts:126`: `mcp_login` loads the registered server, calls discovery/start, saves pending state and returns the verification URI. `mcp_login_complete` at line 145 loads pending state, polls, saves the token and probes tools. `mcp_status` at line 168 probes the registered configuration.
- `apps/engine/src/tools/mcp-auth.ts`: `discoverDeviceAuth` reads protected-resource metadata and a `device_code` hint, or selects an authorization server by name heuristic. `startDeviceFlow` uses fixed `hermes` client/scope values. `pollDeviceToken` loops against the token endpoint; pending/token persistence uses engine files. None of these establishes a human-approved exact method for Mac custody.
- `apps/engine/src/tools/builtin/hitl.ts:294`: `request_mcp_sign_in` uses the ordinary HITL Connect interaction.
- `apps/ui/components/chat/McpSignInBlock.tsx:76`: Connect and Continue reuse `McpOAuthAuthorize` at line 100. This browser interaction is separate from the engine's device fallback.

The Mac keeps the original tool names and human card interaction, while using current typed authority and encrypted storage. Original metadata heuristics, fixed client/scope, polling loop, plaintext pending files and provider-derived error text are not adopted as Mac authority.

## Mounted Mac path on the base

- `apps/engine/src/tools/registry.ts:112` mounts `desktopMcpLoginTools`; `apps/engine/src/desktop/mcp-login-tools/tools.ts` retains the authenticated engine identity and existing MCP grant.
- `apps/ui/app/api/desktop/internal/mcp-login/route.ts` calls `handleDesktopMcpLoginBridge` in `apps/ui/lib/desktop/server/mcp-login-binding.ts:7`.
- That binding constructs `createDesktopMcpLoginRoute` from `apps/engine/src/desktop/mcp-login-tools/route.ts`. The route calls `createDesktopMcpLoginBackend` without its optional device fallback. Start therefore remains unsupported; it does not invoke the custody module or a broker.
- `apps/ui/components/desktop/DesktopConversation.tsx:1437` mounts the existing `mcp-sign-in/DesktopMcpSignInBlock.tsx`. It sends `connect`/`decline`/`cancel` with exact source, card revision and attempt ID.
- `apps/ui/lib/desktop/server/mcp-sign-in/runtime.ts:41` reserves a Connect attempt, then calls its OAuth port.
- `apps/ui/lib/desktop/server/mcp-sign-in/binding.ts:58` validates current source, coworker/session, grant and registration. Its OAuth start at line 88 calls `service.oauth.start`; cancel at line 110 calls `service.oauth.cancel`. These are browser OAuth operations.
- `packages/contracts/src/desktop-mcp-sign-in.ts:77` defines the strict existing decision. Its source contains the server snapshot, but the decision has no exact device-method approval. The new regression passes this actual valid Connect DTO into the device approval boundary and expects refusal before reservation or broker effects. Injecting a `method` into the strict decision is also refused.
- `apps/ui/lib/desktop/server/mcp-binding.ts` owns the existing remote MCP store/runtime, `authorizeRun`, owner generations, master-key access, browser OAuth and shutdown. These remain the sole production authority/lifetime.
- `apps/ui/lib/desktop/server/round38-schema.ts` already registers version 37, `mcp-device-attempt-custody`. No new schema allocation is needed for the already-delivered custody source.

## Existing binding reused, including fake-broker flow

Use `CanonicalDeviceCustodyBinding` from `apps/ui/lib/desktop/server/mcp-device-custody/binding.ts`; its `approvedMethod` and `broker` ports already have the needed local seam.

1. The ordinary backend authenticates the active run, resolves its current local coworker and exact registered HTTP server, and excludes manually configured bearers and SSE.
2. `bindApprovedMcpDeviceCustody` reuses `authorizeRun`, owner and registration lifecycle watchers. It validates immutable registration ID and workspace against the authority lease returned by `approvedMethod(target, signal)`.
3. `mcp-device-custody/custody.ts` parses the approval and checks owner, engine coworker, engine session, name, registration revision, resource URL, approval expiry and current lease. It rereads and compares the entire parsed approval around waits. The run ID remains checked by canonical `authorizeRun` rather than copied into a new permission system.
4. Custody seals a durable request reservation before the effect. `broker.start(approval.method, signal)` receives only the exact supported approved method. `broker.poll(approval.method, privateDeviceCode, signal)` receives the same method and the pending code decrypted in memory from encrypted custody. These are existing in-process ports, not model APIs.
5. Strict start/poll response parsers bound sizes and accepted shapes. A successful token reaches the existing `RemoteMcpStore.writeOAuth` with exact owner/name/revision and lifecycle admission. It remains encrypted. Only the existing backend's successful probe may publish connected tool names.
6. Model responses expose only the existing `DeviceView`/inventory contract. Passive `inspect` never polls or writes and does not treat a saved credential as a verified connection.

The fixture exercises this chain without ambient keys, accounts or network. Its SQLite database lives in a newly created temporary directory and is cleaned up when root runs it; all identities, approval data, key bytes, responses and credentials are synthetic. Neither the fake broker nor the fixture was run by this lane.

## Focused authored regressions — unrun

The expanded `binding.test.ts` covers:

- Exact method and private code arguments at the existing fake-broker start/poll ports; canonical encrypted credential write and real backend projection/probe boundary.
- Synthetic private bytes absent from serialized login responses, inventory/status, passive inspection and raw encrypted custody/OAuth rows; no console log/info/warn/error/debug calls during the success path and invalid/rejected broker responses. This is scoped source coverage, not a claim about installed-app telemetry.
- Foreign workspace, registration ID, local owner, engine coworker/session, server name and registration revision rejected before broker effects.
- Actual current browser Connect DTO refused as device authority; extra device method fields refused by the current strict Connect decision.
- Missing broker returns unsupported without reserving a custody row.
- Unsupported method kind, mismatched resource, foreign issuer endpoint, query-bearing verification link and client-secret shape rejected before effects.
- Expired human approval refused before reservation; expired waiting attempt projected passively without writes, then retired on explicit completion without a poll.
- Stop clears the exact waiting secret, remains terminal across binding recreation, and cannot restart or poll the old attempt.
- Delayed authorized responses after exact Stop, lease revoke or attempt expiry remain unknown, install no token and publish no tools. Recreation cannot replay the effect.
- Client ID, scope and credential-generation changes during the provider wait block late credential installation.
- Optimistic registration edit through the existing store prevents the old waiting attempt from polling again.
- Invalid and rejected start/poll responses retain durable unknown state across recreation; same-ID and new-ID calls cannot replay effects. Provider-derived diagnostics remain absent from results and console calls.

Existing `custody.test.ts`, backend/route/tool suites and the base binding cases remain intact. The previous lane's separate `restart.test.ts` source is not on this base and was not copied here; root can select that earlier regression commit separately if desired. These new recreation cases exercise settled unknown/terminal records, not abrupt process death at every reservation point.

## Exact missing prerequisites and root integration seam

**Human authority:** extend the existing human interaction and its durable source/attempt authority so a current user decision reviews and records an immutable supported `device-code-link-v1` method: resource, issuer, device/token endpoints, safe verification URI, client ID and optional scope. Bind it to canonical workspace, local coworker, engine coworker/session, immutable registration ID/revision, credential generation and bounded expiry. The trusted reader must provide `DeviceApprovalLease` with a revocation signal and a checker that stays current. A browser Connect, an MCP grant, model-supplied values, metadata discovery or a failed OAuth attempt cannot be converted into this lease. Continuation authority across the original HITL run and later active tool run must be explicitly defined and revalidated.

**Broker:** provide a reviewed implementation of the existing start/single-exchange poll port, admitting only the approved method. The network layer must establish exact metadata/resource/issuer binding, bounded bodies, cancellation, redirect refusal and public-address/TLS validation. The local method schema by itself is not a DNS/network safety boundary. No production device broker exists in this delivery.

**Mount and lifecycle:** once both prerequisites exist, root constructs custody once inside the existing `mcp-binding.ts` service lifetime using its DB, secure key function, canonical workspace, store/runtime, `authorizeRun`, owner watcher and shutdown. Reuse the current binding type; do not create a second MCP service, registry, OAuth store or migration. The root-owned authenticated route needs a typed per-service fallback resolver so its sole backend construction receives that lifetime's `custody.fallback` as the third argument. Preserve bounded parsing, authentication, final registration checks, fixed errors and no-store responses. The current route has no such resolver; merely returning custody from the service will not activate it.

**Stop/revoke:** existing browser `oauth.cancel` does not clean up device custody. Bind the exact approved snapshot to human Stop/cancel, revoke, owner deletion/disable, registration replacement and shutdown. Await `custody.stop(exactApproval)` for waiting-secret retirement; abort/check the live lease and existing lifecycle for active effects. A possibly issued start/poll/write stays unknown. Do not reset a slot, infer success or automatically retry an effect after restart. Root must define any explicit later reconciliation/retirement policy before allowing a new approval to replace an ambiguous attempt. Unrelated credentials must remain untouched.

**Unsupported product shapes:** separate user-code prompts, dynamic verification URLs carrying secret material, client secrets and raw provider errors have no safe model-facing channel in the current `DeviceView`. They must stay unsupported unless root adds and reviews an appropriate human-only interaction and authority contract. This lane does not invent that interaction.

## Suggested root board and cold-restart procedure

1. Run source/type/security checks, focused binding/custody/backend/route/tool suites and migration coverage. Use synthetic fixtures first. This lane has executed none of them.
2. In the sandboxed Mac app, open a coworker from the board and the existing MCP card. On the current unbound mount, fallback must stay unavailable. Mount/read/status/cold restart must not create a device attempt or contact a broker. Browser Connect should retain its existing behavior.
3. After root supplies explicit method authority and a fake broker in the existing service lifetime, approve one supported exact fixture method. Confirm only the approved safe verification URI is shown, never device codes, token bytes, credential-derived links or provider diagnostics. Connected/tools must follow a successful canonical probe.
4. Pause the fake broker during start and poll; Stop, revoke, disable/delete the coworker or edit the registration. Resolve the delayed fake response and confirm no late credential or tool publication. Repeat Stop for the exact attempt and preserve unrelated/manual/browser credentials.
5. Reopen from the board after cold restart with waiting, expired, cancelled and unknown custody. Passive loading must not poll or write. Waiting requires explicit current completion after its interval and before expiry. Unknown remains unknown; neither the old call ID nor a new one may repeat the effect. Also exercise abrupt restart during starting, polling and committing using root's durable reservation fixtures.
6. Inspect root-controlled model results, rendered status and app logs for synthetic private sentinels; verify encrypted pending and OAuth storage without exposing actual keys or credentials. Revisit board/chat selection and defaults after restart.

## Delivery boundary

Source inspection and local Git metadata/status only. No tests, fixture execution, typecheck, lint, builds, app launches, installations, native board/cold-restart QA, provider accounts, credentials, real broker/server, network changes, VM/profile changes, push, PR, merge or publication. Root owns execution, integration and acceptance. The fixture documents the existing capability behind its authority gate; it does not claim that device sign-in is mounted or accepted.
